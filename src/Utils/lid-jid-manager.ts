import type { SignalAuthState } from '../Types'
import type { ILogger } from './logger'
import { isLidUser, isJidUser, jidNormalizedUser } from '../WABinary'

export interface LIDMapping {
    phoneNumber: string
    lidJid: string
    lastUsed: number
    migrationDate?: number
}

export interface LIDManagerConfig {
    auth: SignalAuthState
    logger: ILogger
}

/**
 * Gestor robusto para mapeo y migración de JIDs LID
 * Maneja la complejidad de usuarios con múltiples identidades (PN y LID)
 */
export class LIDJIDManager {
    private auth: SignalAuthState
    private logger: ILogger
    private lidMappingCache = new Map<string, LIDMapping>()
    private sessionMigrationQueue = new Set<string>()

    constructor(config: LIDManagerConfig) {
        this.auth = config.auth
        this.logger = config.logger
    }

    /**
     * Obtiene el JID criptográfico correcto para desencriptación
     * Este es el JID que debe usarse para buscar sesiones Signal
     */
    async getCryptographicJID(originalJid: string, messageNode: any): Promise<string> {
        // 1. Si no es LID, usar JID normal
        if (!isLidUser(originalJid)) {
            return jidNormalizedUser(originalJid)
        }

        // 2. Para usuarios LID, verificar si ya tenemos mapeo
        const mapping = await this.getLIDMapping(originalJid)
        if (mapping) {
            // Actualizar timestamp de uso
            mapping.lastUsed = Date.now()
            await this.saveLIDMapping(mapping)

            // Si tenemos sesión con LID, usar LID; sino usar PN
            const lidSessionExists = await this.hasSession(originalJid)
            const pnSessionExists = await this.hasSession(mapping.phoneNumber)

            if (lidSessionExists) {
                this.logger.debug({ originalJid, decision: 'lid' }, 'using LID for crypto')
                return originalJid
            } else if (pnSessionExists) {
                this.logger.debug({ originalJid, phoneNumber: mapping.phoneNumber, decision: 'pn' }, 'using PN for crypto')
                // Programar migración de sesión
                this.scheduleSessionMigration(mapping.phoneNumber, originalJid)
                return mapping.phoneNumber
            }
        }

        // 3. Crear nuevo mapeo si no existe
        const phoneNumber = this.extractPhoneNumberFromLID(originalJid, messageNode)
        if (phoneNumber) {
            const newMapping: LIDMapping = {
                phoneNumber,
                lidJid: originalJid,
                lastUsed: Date.now()
            }
            await this.saveLIDMapping(newMapping)
            this.logger.info({ originalJid, phoneNumber }, 'created new LID mapping')
            return phoneNumber // Usar PN para nueva sesión
        }

        // 4. Fallback: usar JID original
        this.logger.warn({ originalJid }, 'fallback to original JID for crypto')
        return originalJid
    }

    /**
     * Obtiene el JID de routing (para mostrar en chat, envíos, etc.)
     */
    getRoutingJID(cryptoJid: string, messageNode: any): string {
        // Para routing, usar sender_pn si está disponible
        if (messageNode?.attrs?.sender_pn) {
            return jidNormalizedUser(messageNode.attrs.sender_pn)
        }
        return jidNormalizedUser(cryptoJid)
    }

    /**
     * Migra sesión de PN a LID automáticamente
     */
    private async migrateSessionFromPNToLID(phoneNumberJid: string, lidJid: string): Promise<boolean> {
        try {
            this.logger.info({ from: phoneNumberJid, to: lidJid }, 'migrating session from PN to LID')

            // 1. Obtener sesión actual con PN
            const { [phoneNumberJid]: existingSession } = await this.auth.keys.get('session', [phoneNumberJid])
            if (!existingSession) {
                this.logger.debug({ phoneNumberJid }, 'no existing session to migrate')
                return false
            }

            // 2. Copiar sesión a nuevo JID LID
            await this.auth.keys.set({
                session: {
                    [lidJid]: existingSession
                }
            })

            // 3. Actualizar mapping
            const mapping = await this.getLIDMapping(lidJid)
            if (mapping) {
                mapping.migrationDate = Date.now()
                await this.saveLIDMapping(mapping)
            }

            this.logger.info({ from: phoneNumberJid, to: lidJid }, 'session migrated successfully')
            return true

        } catch (error) {
            this.logger.error({ from: phoneNumberJid, to: lidJid, error }, 'session migration failed')
            return false
        }
    }

    /**
     * Recovery automático cuando falla desencriptación
     */
    async handleDecryptionFailure(jid: string, error: any): Promise<string | null> {
        if (!error.message?.includes('Bad MAC')) {
            return null
        }

        this.logger.warn({ jid, error: error.message }, 'attempting recovery from decryption failure')

        // 1. Si es LID, intentar con PN alternativo
        if (isLidUser(jid)) {
            const mapping = await this.getLIDMapping(jid)
            if (mapping?.phoneNumber) {
                const hasPhoneSession = await this.hasSession(mapping.phoneNumber)
                if (hasPhoneSession) {
                    this.logger.info({ lidJid: jid, phoneNumber: mapping.phoneNumber }, 'recovering using PN session')
                    return mapping.phoneNumber
                }
            }
        }

        // 2. Si es PN, buscar LID alternativo
        if (isJidUser(jid)) {
            const lidAlternative = await this.findLIDForPhoneNumber(jid)
            if (lidAlternative) {
                const hasLidSession = await this.hasSession(lidAlternative)
                if (hasLidSession) {
                    this.logger.info({ phoneNumber: jid, lidJid: lidAlternative }, 'recovering using LID session')
                    return lidAlternative
                }
            }
        }

        // 3. Programar nueva sesión
        this.logger.info({ jid }, 'scheduling new session fetch for recovery')
        return 'REQUEST_NEW_SESSION'
    }

    /**
     * Procesa cola de migración de sesiones
     */
    private scheduleSessionMigration(fromJid: string, toJid: string): void {
        const migrationKey = `${fromJid}->${toJid}`
        if (this.sessionMigrationQueue.has(migrationKey)) {
            return
        }

        this.sessionMigrationQueue.add(migrationKey)

        // Procesar en el siguiente tick para no bloquear
        process.nextTick(async () => {
            try {
                await this.migrateSessionFromPNToLID(fromJid, toJid)
            } finally {
                this.sessionMigrationQueue.delete(migrationKey)
            }
        })
    }

    private async hasSession(jid: string): Promise<boolean> {
        const { [jid]: session } = await this.auth.keys.get('session', [jid])
        return !!session
    }

    private async getLIDMapping(lidJid: string): Promise<LIDMapping | null> {
        // Primero buscar en cache
        if (this.lidMappingCache.has(lidJid)) {
            return this.lidMappingCache.get(lidJid)!
        }

        // Buscar en storage persistente (usar pre-key como namespace temporal)
        const storageKey = `lid-mapping-${lidJid}`
        const { [storageKey]: storedMapping } = await this.auth.keys.get('pre-key', [storageKey])
        if (storedMapping) {
            try {
                const mapping = JSON.parse(Buffer.from(storedMapping.private).toString())
                this.lidMappingCache.set(lidJid, mapping)
                return mapping
            } catch (error) {
                this.logger.debug({ lidJid, error }, 'failed to parse stored LID mapping')
            }
        }

        return null
    }

    private async saveLIDMapping(mapping: LIDMapping): Promise<void> {
        // Guardar en cache
        this.lidMappingCache.set(mapping.lidJid, mapping)

        // Guardar en storage persistente (usar pre-key como namespace temporal)
        const storageKey = `lid-mapping-${mapping.lidJid}`
        const serialized = JSON.stringify(mapping)
        await this.auth.keys.set({
            'pre-key': {
                [storageKey]: {
                    private: Buffer.from(serialized),
                    public: Buffer.from('LID_MAPPING')
                }
            }
        })
    }

    private extractPhoneNumberFromLID(lidJid: string, messageNode: any): string | null {
        // Intentar extraer de sender_pn
        if (messageNode?.attrs?.sender_pn) {
            return jidNormalizedUser(messageNode.attrs.sender_pn)
        }

        // Extraer número del LID (formato: 1234567890@lid -> 1234567890@s.whatsapp.net)
        const phoneNumber = lidJid.replace('@lid', '@s.whatsapp.net')
        return isJidUser(phoneNumber) ? phoneNumber : null
    }

    private async findLIDForPhoneNumber(phoneJid: string): Promise<string | null> {
        // Buscar en mappings existentes
        for (const [lidJid, mapping] of this.lidMappingCache.entries()) {
            if (mapping.phoneNumber === phoneJid) {
                return lidJid
            }
        }

        // TODO: Buscar en storage si no está en cache
        return null
    }

    /**
     * Limpia cache y mappings antiguos
     */
    async cleanup(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
        const now = Date.now()
        const toDelete: string[] = []

        for (const [lidJid, mapping] of this.lidMappingCache.entries()) {
            if (now - mapping.lastUsed > maxAgeMs) {
                toDelete.push(lidJid)
            }
        }

        for (const lidJid of toDelete) {
            this.lidMappingCache.delete(lidJid)
            const storageKey = `lid-mapping-${lidJid}`
            await this.auth.keys.set({ 'pre-key': { [storageKey]: null } })
        }

        if (toDelete.length > 0) {
            this.logger.debug({ cleanedCount: toDelete.length }, 'cleaned up old LID mappings')
        }
    }
}

/**
 * Factory function para crear el manager
 */
export const createLIDJIDManager = (config: LIDManagerConfig): LIDJIDManager => {
    return new LIDJIDManager(config)
}
