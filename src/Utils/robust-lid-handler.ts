import type { BinaryNode } from '../WABinary'
import type { SignalRepository } from '../Types'
import type { ILogger } from './logger'
import { isLidUser, isJidUser, jidNormalizedUser } from '../WABinary'

export interface LIDDecryptionContext {
    originalJid: string
    fallbackJid?: string
    messageType: string
    ciphertext: Uint8Array
    attempts: number
}

/**
 * Handler robusto para desencriptación de mensajes LID
 * Maneja fallos automáticamente con fallbacks inteligentes
 */
export class RobustLIDHandler {
    private logger: ILogger
    private repository: SignalRepository

    constructor(logger: ILogger, repository: SignalRepository) {
        this.logger = logger
        this.repository = repository
    }

    /**
     * Desencripta mensaje con recovery automático
     */
    async decryptWithRecovery(context: LIDDecryptionContext): Promise<Uint8Array> {
        const { originalJid, fallbackJid, messageType, ciphertext } = context

        // Primer intento con JID principal
        try {
            this.logger.debug({ jid: originalJid, attempt: 1 }, 'attempting decryption')

            return await this.repository.decryptMessage({
                jid: originalJid,
                type: messageType as any,
                ciphertext
            })

        } catch (firstError: any) {
            if (!firstError.message?.includes('Bad MAC')) {
                throw firstError // Error no recuperable
            }

            this.logger.warn({
                jid: originalJid,
                error: firstError.message,
                hasFallback: !!fallbackJid
            }, 'first decryption failed, attempting recovery')

            // Segundo intento con JID alternativo
            if (fallbackJid && fallbackJid !== originalJid) {
                try {
                    this.logger.info({
                        originalJid,
                        fallbackJid,
                        attempt: 2
                    }, 'attempting decryption with fallback JID')

                    const result = await this.repository.decryptMessage({
                        jid: fallbackJid,
                        type: messageType as any,
                        ciphertext
                    })

                    this.logger.info({
                        recoveredWith: fallbackJid,
                        originalJid
                    }, 'decryption recovered successfully')

                    return result

                } catch (secondError: any) {
                    this.logger.error({
                        originalJid,
                        fallbackJid,
                        originalError: firstError.message,
                        fallbackError: secondError.message
                    }, 'both decryption attempts failed')
                }
            }

            // Si llegamos aquí, ambos intentos fallaron
            throw new Error(`Decryption failed for ${originalJid}${fallbackJid ? ` and fallback ${fallbackJid}` : ''}: ${firstError.message}`)
        }
    }

    /**
     * Prepara contexto de desencriptación desde nodo de mensaje
     */
    createDecryptionContext(stanza: BinaryNode, messageType: string, ciphertext: Uint8Array): LIDDecryptionContext {
        // Determinar JID principal y fallback
        let originalJid: string
        let fallbackJid: string | undefined

        if (stanza.attrs.original_from && isLidUser(stanza.attrs.original_from)) {
            // Mensaje LID: usar LID como principal, PN como fallback
            originalJid = stanza.attrs.original_from
            fallbackJid = stanza.attrs.sender_pn ? jidNormalizedUser(stanza.attrs.sender_pn) : undefined
        } else {
            // Mensaje normal: usar JID detectado
            const sender = stanza.attrs.from
            const author = stanza.attrs.participant || sender
            originalJid = isJidUser(sender!) ? sender! : (author || sender!)
        }

        return {
            originalJid: jidNormalizedUser(originalJid),
            fallbackJid: fallbackJid ? jidNormalizedUser(fallbackJid) : undefined,
            messageType,
            ciphertext,
            attempts: 0
        }
    }

    /**
     * Análisis de fallos para logging y debugging
     */
    analyzeDecryptionFailure(context: LIDDecryptionContext, error: Error): void {
        const analysis = {
            jid: context.originalJid,
            isLID: isLidUser(context.originalJid),
            hasFallback: !!context.fallbackJid,
            messageType: context.messageType,
            errorType: this.classifyError(error),
            errorMessage: error.message,
            timestamp: Date.now()
        }

        this.logger.error(analysis, 'decryption failure analysis')

        // Métricas para monitoring (opcional)
        if (analysis.isLID) {
            this.logger.info({ lidJid: analysis.jid }, 'LID_DECRYPTION_FAILURE')
        }
    }

    private classifyError(error: Error): string {
        const message = error.message.toLowerCase()

        if (message.includes('bad mac')) return 'BAD_MAC'
        if (message.includes('session')) return 'NO_SESSION'
        if (message.includes('prekey')) return 'PREKEY_ERROR'
        if (message.includes('identity')) return 'IDENTITY_ERROR'

        return 'UNKNOWN'
    }
}

/**
 * Factory function
 */
export const createRobustLIDHandler = (logger: ILogger, repository: SignalRepository): RobustLIDHandler => {
    return new RobustLIDHandler(logger, repository)
}
