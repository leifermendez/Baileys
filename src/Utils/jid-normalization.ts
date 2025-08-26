import { isLidUser, isJidUser, jidNormalizedUser } from '../WABinary'

/**
 * Normaliza JIDs para Chat ID consistente
 * Convierte LID → PN para evitar conversaciones duplicadas
 */
export const normalizeChatId = (jid: string, senderPn?: string): string => {
    if (!jid) return jid

    // Si es usuario LID, convertir a PN para unificar conversaciones
    if (isLidUser(jid)) {
        // Priorizar sender_pn si está disponible
        if (senderPn && isJidUser(senderPn)) {
            return jidNormalizedUser(senderPn)
        }

        // Convertir LID a PN (12345@lid → 12345@s.whatsapp.net)
        const phoneJid = jid.replace('@lid', '@s.whatsapp.net')
        if (isJidUser(phoneJid)) {
            return jidNormalizedUser(phoneJid)
        }
    }

    // Para cualquier otro caso, normalizar normalmente
    return jidNormalizedUser(jid)
}

/**
 * Obtiene el JID de crypto (para desencriptación) preservando el original
 */
export const getCryptoJid = (originalJid: string, senderPn?: string): string => {
    // Para crypto, usar el JID original si es LID
    if (isLidUser(originalJid)) {
        return jidNormalizedUser(originalJid)
    }

    // Para usuarios normales, usar JID normalizado
    return jidNormalizedUser(originalJid)
}

/**
 * Obtiene información completa de JIDs para un mensaje LID
 */
export interface NormalizedJids {
    /** JID para mostrar en chat (normalizado para evitar duplicados) */
    chatId: string
    /** JID para desencriptación (preserva LID si es necesario) */
    cryptoJid: string
    /** JID del autor (para participant tracking) */
    authorJid: string
    /** Información de routing original */
    routingInfo: {
        originalFrom: string
        senderPn?: string
        isLid: boolean
    }
}

export const normalizeMessageJids = (
    originalFrom: string,
    participant?: string,
    senderPn?: string
): NormalizedJids => {
    const isLid = isLidUser(originalFrom)

    // Chat ID: siempre usar PN para unificar conversaciones
    const chatId = normalizeChatId(originalFrom, senderPn)

    // Crypto JID: preservar LID para desencriptación correcta
    const cryptoJid = getCryptoJid(originalFrom, senderPn)

    // Author JID: usar participant si existe, sino el from original
    const authorJid = participant || originalFrom

    return {
        chatId: jidNormalizedUser(chatId),
        cryptoJid: jidNormalizedUser(cryptoJid),
        authorJid: jidNormalizedUser(authorJid),
        routingInfo: {
            originalFrom,
            senderPn,
            isLid: Boolean(isLid)
        }
    }
}
