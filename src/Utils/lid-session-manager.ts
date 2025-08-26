import type { SignalAuthState } from '../Types'
import type { ILogger } from './logger'
import { isLidUser, isJidUser } from '../WABinary'

export interface SessionRecoveryStats {
    totalAttempts: number
    successfulRecoveries: number
    failedRecoveries: number
    lastRecoveryTime: number
}

export interface SessionInfo {
    jid: string
    exists: boolean
    lastAccessed?: number
    errorCount?: number
}

/**
 * Gestor de sesiones con recovery automático y cache inteligente
 * Se encarga de la gestión avanzada de sesiones Signal para usuarios LID
 */
export class LIDSessionManager {
    private auth: SignalAuthState
    private logger: ILogger
    private sessionCache = new Map<string, SessionInfo>()
    private recoveryStats: SessionRecoveryStats = {
        totalAttempts: 0,
        successfulRecoveries: 0,
        failedRecoveries: 0,
        lastRecoveryTime: 0
    }

    // Cache TTL en milisegundos (5 minutos)
    private readonly CACHE_TTL = 5 * 60 * 1000

    constructor(auth: SignalAuthState, logger: ILogger) {
        this.auth = auth
        this.logger = logger

        // Limpiar cache periódicamente
        setInterval(() => this.cleanupCache(), this.CACHE_TTL)
    }

    /**
     * Verifica si existe sesión con cache inteligente
     */
    async hasSession(jid: string): Promise<boolean> {
        const cacheKey = this.normalizeCacheKey(jid)
        const cached = this.sessionCache.get(cacheKey)

        // Retornar de cache si es válido
        if (cached && this.isCacheValid(cached)) {
            return cached.exists
        }

        // Consultar storage
        try {
            const { [jid]: session } = await this.auth.keys.get('session', [jid])
            const exists = !!session

            // Actualizar cache
            this.sessionCache.set(cacheKey, {
                jid,
                exists,
                lastAccessed: Date.now()
            })

            return exists
        } catch (error) {
            this.logger.error({ jid, error }, 'failed to check session existence')
            return false
        }
    }

    /**
     * Recovery automático de sesiones
     */
    async recoverSession(primaryJid: string, alternativeJid?: string): Promise<string | null> {
        this.recoveryStats.totalAttempts++

        try {
            this.logger.info({ primaryJid, alternativeJid }, 'attempting session recovery')

            // 1. Verificar si la sesión principal existe realmente
            const primaryExists = await this.hasSession(primaryJid)
            if (primaryExists) {
                // Cache podría estar desactualizado, intentar limpiar error
                this.clearSessionError(primaryJid)
                this.recoveryStats.successfulRecoveries++
                return primaryJid
            }

            // 2. Si hay alternativa, verificar
            if (alternativeJid) {
                const altExists = await this.hasSession(alternativeJid)
                if (altExists) {
                    this.logger.info({
                        primary: primaryJid,
                        recovered: alternativeJid
                    }, 'recovered using alternative session')

                    // Intentar migrar sesión si es posible
                    await this.migrateSession(alternativeJid, primaryJid)

                    this.recoveryStats.successfulRecoveries++
                    this.recoveryStats.lastRecoveryTime = Date.now()
                    return alternativeJid
                }
            }

            // 3. Si es usuario LID, buscar sesión PN correspondiente
            if (isLidUser(primaryJid)) {
                const phoneJid = this.lidToPhoneJid(primaryJid)
                if (phoneJid) {
                    const phoneExists = await this.hasSession(phoneJid)
                    if (phoneExists) {
                        this.logger.info({
                            lidJid: primaryJid,
                            recoveredPhone: phoneJid
                        }, 'recovered LID using phone session')

                        this.recoveryStats.successfulRecoveries++
                        this.recoveryStats.lastRecoveryTime = Date.now()
                        return phoneJid
                    }
                }
            }

            // 4. Si es usuario phone, buscar LID correspondiente
            if (isJidUser(primaryJid)) {
                const lidJid = this.phoneToLidJid(primaryJid)
                if (lidJid) {
                    const lidExists = await this.hasSession(lidJid)
                    if (lidExists) {
                        this.logger.info({
                            phoneJid: primaryJid,
                            recoveredLid: lidJid
                        }, 'recovered phone using LID session')

                        this.recoveryStats.successfulRecoveries++
                        this.recoveryStats.lastRecoveryTime = Date.now()
                        return lidJid
                    }
                }
            }

            // Recovery falló
            this.recoveryStats.failedRecoveries++
            this.logger.warn({ primaryJid, alternativeJid }, 'session recovery failed')
            return null

        } catch (error) {
            this.recoveryStats.failedRecoveries++
            this.logger.error({ primaryJid, alternativeJid, error }, 'session recovery error')
            return null
        }
    }

    /**
     * Migra sesión entre JIDs (PN ↔ LID)
     */
    private async migrateSession(fromJid: string, toJid: string): Promise<boolean> {
        try {
            this.logger.debug({ from: fromJid, to: toJid }, 'migrating session')

            const { [fromJid]: sourceSession } = await this.auth.keys.get('session', [fromJid])
            if (!sourceSession) {
                return false
            }

            // Copiar sesión
            await this.auth.keys.set({
                session: {
                    [toJid]: sourceSession
                }
            })

            // Actualizar cache
            this.sessionCache.set(this.normalizeCacheKey(toJid), {
                jid: toJid,
                exists: true,
                lastAccessed: Date.now()
            })

            this.logger.info({ from: fromJid, to: toJid }, 'session migrated successfully')
            return true

        } catch (error) {
            this.logger.error({ from: fromJid, to: toJid, error }, 'session migration failed')
            return false
        }
    }

    /**
     * Limpia sesión corrupta
     */
    async clearCorruptedSession(jid: string): Promise<void> {
        try {
            await this.auth.keys.set({ session: { [jid]: null } })

            // Actualizar cache
            this.sessionCache.set(this.normalizeCacheKey(jid), {
                jid,
                exists: false,
                lastAccessed: Date.now()
            })

            this.logger.info({ jid }, 'cleared corrupted session')
        } catch (error) {
            this.logger.error({ jid, error }, 'failed to clear corrupted session')
        }
    }

    /**
     * Fuerza nueva sesión para JID
     */
    async forceNewSession(jid: string): Promise<void> {
        // Limpiar sesión existente
        await this.clearCorruptedSession(jid)

        // Marcar para re-fetch
        this.sessionCache.delete(this.normalizeCacheKey(jid))

        this.logger.info({ jid }, 'forced new session request')
    }

    /**
     * Reporta estadísticas de recovery
     */
    getRecoveryStats(): SessionRecoveryStats {
        return { ...this.recoveryStats }
    }

    /**
     * Convierte LID a Phone JID
     */
    private lidToPhoneJid(lidJid: string): string | null {
        if (!isLidUser(lidJid)) return null
        return lidJid.replace('@lid', '@s.whatsapp.net')
    }

    /**
     * Convierte Phone JID a LID
     */
    private phoneToLidJid(phoneJid: string): string | null {
        if (!isJidUser(phoneJid)) return null
        return phoneJid.replace('@s.whatsapp.net', '@lid')
    }

    /**
     * Normaliza clave de cache
     */
    private normalizeCacheKey(jid: string): string {
        return jid.toLowerCase()
    }

    /**
     * Verifica si cache es válido
     */
    private isCacheValid(cached: SessionInfo): boolean {
        if (!cached.lastAccessed) return false
        return (Date.now() - cached.lastAccessed) < this.CACHE_TTL
    }

    /**
     * Limpia cache expirado
     */
    private cleanupCache(): void {
        const now = Date.now()
        const toDelete: string[] = []

        for (const [key, info] of this.sessionCache.entries()) {
            if (!info.lastAccessed || (now - info.lastAccessed) > this.CACHE_TTL) {
                toDelete.push(key)
            }
        }

        for (const key of toDelete) {
            this.sessionCache.delete(key)
        }

        if (toDelete.length > 0) {
            this.logger.debug({ cleanedCount: toDelete.length }, 'cleaned session cache')
        }
    }

    /**
     * Marca error de sesión para tracking
     */
    private markSessionError(jid: string): void {
        const cacheKey = this.normalizeCacheKey(jid)
        const cached = this.sessionCache.get(cacheKey)

        if (cached) {
            cached.errorCount = (cached.errorCount || 0) + 1
        } else {
            this.sessionCache.set(cacheKey, {
                jid,
                exists: false,
                errorCount: 1,
                lastAccessed: Date.now()
            })
        }
    }

    /**
     * Limpia contador de errores
     */
    private clearSessionError(jid: string): void {
        const cacheKey = this.normalizeCacheKey(jid)
        const cached = this.sessionCache.get(cacheKey)

        if (cached) {
            cached.errorCount = 0
        }
    }
}
