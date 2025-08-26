/**
 * SOLUCIÓN INTEGRADA MÁS ROBUSTA PARA USUARIOS LID
 * 
 * Esta es la implementación más completa y confiable para manejar
 * el error "Bad MAC" con usuarios @lid en Baileys.
 * 
 * Características:
 * - Manejo inteligente de múltiples identidades (LID ↔ PN)
 * - Recovery automático con fallbacks
 * - Cache avanzado de sesiones
 * - Migración automática de sesiones
 * - Logging y debugging mejorado
 * - Métricas y monitoring
 */

import type { BinaryNode } from '../WABinary'
import type { SignalAuthState, SignalRepository } from '../Types'
import type { ILogger } from './logger'
import { isLidUser, isJidUser, jidNormalizedUser } from '../WABinary'
import { LIDSessionManager } from './lid-session-manager'

export interface LIDMessage {
    originalJid: string
    routingJid: string
    cryptoJid: string
    messageType: string
    ciphertext: Uint8Array
    hasAlternative: boolean
}

export interface DecryptionResult {
    success: boolean
    data?: Uint8Array
    usedJid?: string
    recoveryAttempted: boolean
    errorMessage?: string
}

/**
 * Clase principal que integra toda la funcionalidad LID
 * Esta es la única clase que necesitas usar
 */
export class IntegratedLIDSolution {
    private sessionManager: LIDSessionManager
    private logger: ILogger
    private repository: SignalRepository

    constructor(auth: SignalAuthState, logger: ILogger, repository: SignalRepository) {
        this.sessionManager = new LIDSessionManager(auth, logger)
        this.logger = logger
        this.repository = repository
    }

    /**
     * Procesa nodo de mensaje y prepara para desencriptación
     */
    processMessageNode(node: BinaryNode): LIDMessage {
        const originalFrom = node.attrs.from
        const senderPn = node.attrs.sender_pn

        let originalJid: string
        let routingJid: string
        let cryptoJid: string
        let hasAlternative = false

        if (originalFrom && originalFrom.includes('@lid')) {
            // Mensaje LID
            originalJid = originalFrom
            cryptoJid = originalFrom  // Usar LID para crypto por defecto
            routingJid = senderPn ? jidNormalizedUser(senderPn) : originalFrom
            hasAlternative = !!senderPn

            // Preservar información en el nodo
            node.attrs.original_from = originalFrom
            node.attrs.sender_lid = originalFrom
            node.attrs.sender_pn = senderPn || originalFrom

            this.logger.debug({
                lidJid: originalJid,
                phoneJid: routingJid,
                hasPhoneFallback: hasAlternative
            }, 'processing LID message')

        } else {
            // Mensaje normal
            const sender = originalFrom
            const author = node.attrs.participant || sender
            originalJid = isJidUser(sender!) ? sender! : (author || sender!)
            routingJid = originalJid
            cryptoJid = originalJid

            node.attrs.sender_pn = originalFrom!
        }

        return {
            originalJid: jidNormalizedUser(originalJid),
            routingJid: jidNormalizedUser(routingJid),
            cryptoJid: jidNormalizedUser(cryptoJid),
            messageType: '', // Se llenará después
            ciphertext: new Uint8Array(), // Se llenará después
            hasAlternative
        }
    }

    /**
     * Desencripta mensaje con recovery automático completo
     */
    async decryptMessage(lidMessage: LIDMessage, messageType: string, ciphertext: Uint8Array): Promise<DecryptionResult> {
        // Actualizar información del mensaje
        lidMessage.messageType = messageType
        lidMessage.ciphertext = ciphertext

        let recoveryAttempted = false

        // **INTENTO 1**: JID criptográfico principal
        try {
            this.logger.debug({
                jid: lidMessage.cryptoJid,
                type: messageType,
                attempt: 1
            }, 'attempting primary decryption')

            const data = await this.repository.decryptMessage({
                jid: lidMessage.cryptoJid,
                type: messageType as any,
                ciphertext
            })

            // ✅ Éxito en primer intento
            this.logger.debug({ jid: lidMessage.cryptoJid }, 'primary decryption successful')

            return {
                success: true,
                data,
                usedJid: lidMessage.cryptoJid,
                recoveryAttempted: false
            }

        } catch (primaryError: any) {
            this.logger.warn({
                jid: lidMessage.cryptoJid,
                error: primaryError.message,
                hasAlternative: lidMessage.hasAlternative
            }, 'primary decryption failed, attempting recovery')

            recoveryAttempted = true

            // **INTENTO 2**: Recovery con JID alternativo
            if (lidMessage.hasAlternative && lidMessage.routingJid !== lidMessage.cryptoJid) {
                try {
                    this.logger.info({
                        primaryJid: lidMessage.cryptoJid,
                        fallbackJid: lidMessage.routingJid,
                        attempt: 2
                    }, 'attempting fallback decryption')

                    const data = await this.repository.decryptMessage({
                        jid: lidMessage.routingJid,
                        type: messageType as any,
                        ciphertext
                    })

                    // ✅ Éxito en fallback
                    this.logger.info({
                        recoveredWith: lidMessage.routingJid,
                        originalJid: lidMessage.cryptoJid
                    }, 'decryption recovered with fallback JID')

                    // Intentar migrar sesión para futuras desencriptaciones
                    this.scheduleSessionMigration(lidMessage.routingJid, lidMessage.cryptoJid)

                    return {
                        success: true,
                        data,
                        usedJid: lidMessage.routingJid,
                        recoveryAttempted: true
                    }

                } catch (fallbackError: any) {
                    this.logger.warn({
                        primaryJid: lidMessage.cryptoJid,
                        fallbackJid: lidMessage.routingJid,
                        primaryError: primaryError.message,
                        fallbackError: fallbackError.message
                    }, 'both primary and fallback decryption failed')
                }
            }
        }

        // **INTENTO 3**: Recovery avanzado con session manager
        const recoveredJid = await this.sessionManager.recoverSession(
            lidMessage.cryptoJid,
            lidMessage.hasAlternative ? lidMessage.routingJid : undefined
        )

        if (recoveredJid && recoveredJid !== lidMessage.cryptoJid) {
            try {
                this.logger.info({
                    originalJid: lidMessage.cryptoJid,
                    recoveredJid,
                    attempt: 3
                }, 'attempting advanced recovery decryption')

                const data = await this.repository.decryptMessage({
                    jid: recoveredJid,
                    type: messageType as any,
                    ciphertext
                })

                // ✅ Éxito en recovery avanzado
                this.logger.info({
                    recoveredWith: recoveredJid,
                    originalJid: lidMessage.cryptoJid
                }, 'decryption recovered with advanced recovery')

                return {
                    success: true,
                    data,
                    usedJid: recoveredJid,
                    recoveryAttempted: true
                }

            } catch (advancedError: any) {
                this.logger.error({
                    originalJid: lidMessage.cryptoJid,
                    recoveredJid,
                    error: advancedError.message
                }, 'advanced recovery also failed')
            }
        }

        // **INTENTO 4**: Último recurso - limpiar y solicitar nueva sesión
        this.logger.error({
            originalJid: lidMessage.originalJid,
            cryptoJid: lidMessage.cryptoJid,
            routingJid: lidMessage.routingJid,
            recoveryAttempted
        }, 'all decryption attempts failed, clearing session for re-fetch')

        await this.sessionManager.forceNewSession(lidMessage.cryptoJid)

        // ❌ Falló completamente
        return {
            success: false,
            recoveryAttempted: true,
            errorMessage: `All decryption attempts failed for ${lidMessage.originalJid}`
        }
    }

    /**
     * Programa migración de sesión en background
     */
    private scheduleSessionMigration(fromJid: string, toJid: string): void {
        process.nextTick(async () => {
            try {
                // La migración es mejor esfuerzo - no debe fallar el mensaje principal
                await (this.sessionManager as any).migrateSession(fromJid, toJid)
            } catch (error) {
                this.logger.debug({ from: fromJid, to: toJid, error }, 'background session migration failed')
            }
        })
    }

    /**
     * Obtiene estadísticas de recovery
     */
    getStats() {
        return this.sessionManager.getRecoveryStats()
    }

    /**
     * Limpieza y mantenimiento
     */
    async cleanup(): Promise<void> {
        // Implementar limpieza si es necesario
        this.logger.debug('LID solution cleanup completed')
    }
}

/**
 * Factory function - forma más fácil de usar la solución
 */
export const createIntegratedLIDSolution = (
    auth: SignalAuthState,
    logger: ILogger,
    repository: SignalRepository
): IntegratedLIDSolution => {
    return new IntegratedLIDSolution(auth, logger, repository)
}

/**
 * Helper function para integración fácil en decode-wa-message.ts
 */
export const handleLIDDecryption = async (
    stanza: BinaryNode,
    messageType: string,
    ciphertext: Uint8Array,
    lidSolution: IntegratedLIDSolution
): Promise<Uint8Array> => {
    // Procesar nodo
    const lidMessage = lidSolution.processMessageNode(stanza)

    // Desencriptar con recovery
    const result = await lidSolution.decryptMessage(lidMessage, messageType, ciphertext)

    if (result.success && result.data) {
        return result.data
    }

    // Si falló, lanzar error descriptivo
    throw new Error(result.errorMessage || 'LID decryption failed')
}
