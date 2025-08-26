/**
 * OPTIMIZED LID HANDLER - VERSION PERFORMANCE
 * 
 * Versión optimizada específicamente para performance
 * - Operaciones síncronas cuando es posible
 * - Early returns para evitar procesamiento innecesario
 * - Cache con límites de tamaño
 * - Logging condicional
 * - Batch operations
 */

import type { BinaryNode } from '../WABinary'
import { isLidUser, isJidUser, jidNormalizedUser } from '../WABinary'
import type { ILogger } from './logger'

interface OptimizedLIDCache {
    [jid: string]: {
        chatId: string
        cryptoJid: string
        timestamp: number
        hitCount: number
    }
}

export class OptimizedLIDHandler {
    private cache: OptimizedLIDCache = {}
    private readonly maxCacheSize: number
    private readonly cacheTTL: number
    private logger: ILogger

    // Performance counters
    private stats = {
        cacheHits: 0,
        cacheMisses: 0,
        optimizations: 0
    }

    constructor(logger: ILogger, options: { maxCacheSize?: number, cacheTTL?: number } = {}) {
        this.logger = logger
        this.maxCacheSize = options.maxCacheSize || 1000
        this.cacheTTL = options.cacheTTL || 5 * 60 * 1000 // 5 minutos

        // Cleanup automático optimizado (solo si hay entries)
        setInterval(() => {
            if (Object.keys(this.cache).length > 0) {
                this.cleanupCache()
            }
        }, this.cacheTTL)
    }

    /**
     * Procesamiento ultrarrápido de JIDs LID
     * Optimizado para casos más comunes primero
     */
    processLIDMessage(node: BinaryNode): { chatId: string, cryptoJid: string } | null {
        const originalFrom = node.attrs.from

        // Early return: no es LID, no hacer nada
        if (!originalFrom || !originalFrom.includes('@lid')) {
            return null
        }

        // Cache lookup (operación más rápida)
        const cached = this.getCached(originalFrom)
        if (cached) {
            this.stats.cacheHits++
            // Solo log en debug mode para performance
            if (this.logger.level === 'debug') {
                this.logger.debug({ originalFrom, cached: true }, 'LID cache hit')
            }
            return { chatId: cached.chatId, cryptoJid: cached.cryptoJid }
        }

        this.stats.cacheMisses++

        // Procesamiento rápido (operaciones síncronas)
        const senderPn = node.attrs.sender_pn
        const result = this.fastNormalization(originalFrom, senderPn)

        // Cache el resultado (operación rápida)
        this.setCached(originalFrom, result)

        // Preservar info en el nodo (una sola vez)
        node.attrs.original_from = originalFrom
        node.attrs.sender_lid = originalFrom
        node.attrs.sender_pn = senderPn || originalFrom

        return result
    }

    /**
     * Normalización ultra-rápida (solo operaciones síncronas)
     */
    private fastNormalization(lidJid: string, senderPn?: string): { chatId: string, cryptoJid: string } {
        // Usar PN para chat ID si está disponible (unificar conversaciones)
        let chatId: string
        if (senderPn && isJidUser(senderPn)) {
            chatId = jidNormalizedUser(senderPn)
        } else {
            // Convertir LID a PN (operación string rápida)
            const phoneJid = lidJid.replace('@lid', '@s.whatsapp.net')
            chatId = jidNormalizedUser(phoneJid)
        }

        // Crypto JID: preservar LID para desencriptación
        const cryptoJid = jidNormalizedUser(lidJid)

        this.stats.optimizations++
        return { chatId, cryptoJid }
    }

    /**
     * Cache ultrarrápido (Map lookup)
     */
    private getCached(jid: string): OptimizedLIDCache[string] | null {
        const cached = this.cache[jid]
        if (!cached) return null

        // TTL check rápido
        if (Date.now() - cached.timestamp > this.cacheTTL) {
            delete this.cache[jid]
            return null
        }

        // Increment hit count para LRU
        cached.hitCount++
        cached.timestamp = Date.now()
        return cached
    }

    /**
     * Cache set optimizado con límites
     */
    private setCached(jid: string, result: { chatId: string, cryptoJid: string }): void {
        // Si cache está lleno, evict LRU
        if (Object.keys(this.cache).length >= this.maxCacheSize) {
            this.evictLRU()
        }

        this.cache[jid] = {
            chatId: result.chatId,
            cryptoJid: result.cryptoJid,
            timestamp: Date.now(),
            hitCount: 1
        }
    }

    /**
     * LRU eviction optimizado
     */
    private evictLRU(): void {
        let oldestKey = ''
        let oldestTime = Date.now()
        let lowestHits = Infinity

        // Find LRU item (considera tanto tiempo como hits)
        for (const [key, entry] of Object.entries(this.cache)) {
            const score = entry.timestamp + (entry.hitCount * 60000) // Bonus por hits
            if (score < oldestTime) {
                oldestTime = score
                oldestKey = key
            }
        }

        if (oldestKey) {
            delete this.cache[oldestKey]
        }
    }

    /**
     * Cleanup optimizado (batch operation)
     */
    private cleanupCache(): void {
        const now = Date.now()
        const toDelete: string[] = []

        // Collect expired keys (no delete durante iteration)
        for (const [key, entry] of Object.entries(this.cache)) {
            if (now - entry.timestamp > this.cacheTTL) {
                toDelete.push(key)
            }
        }

        // Batch delete
        for (const key of toDelete) {
            delete this.cache[key]
        }

        // Solo log si hay cleanup significativo
        if (toDelete.length > 10) {
            this.logger.debug({ cleaned: toDelete.length }, 'LID cache cleanup')
        }
    }

    /**
     * Performance stats
     */
    getPerformanceStats() {
        const cacheSize = Object.keys(this.cache).length
        const hitRate = this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses) || 0

        return {
            cacheSize,
            hitRate: Math.round(hitRate * 100) / 100,
            cacheHits: this.stats.cacheHits,
            cacheMisses: this.stats.cacheMisses,
            optimizations: this.stats.optimizations,
            maxCacheSize: this.maxCacheSize
        }
    }

    /**
     * Reset stats para benchmarking
     */
    resetStats(): void {
        this.stats = { cacheHits: 0, cacheMisses: 0, optimizations: 0 }
    }

    /**
     * Limpieza manual (para testing)
     */
    clearCache(): void {
        this.cache = {}
        this.resetStats()
    }
}

/**
 * Factory function optimizada
 */
export const createOptimizedLIDHandler = (
    logger: ILogger,
    options: { maxCacheSize?: number, cacheTTL?: number } = {}
): OptimizedLIDHandler => {
    return new OptimizedLIDHandler(logger, options)
}

/**
 * Helper para integración en decode-wa-message.ts
 */
export const processLIDOptimized = (
    stanza: BinaryNode,
    handler: OptimizedLIDHandler
): { chatId: string, cryptoJid: string } | null => {
    return handler.processLIDMessage(stanza)
}
