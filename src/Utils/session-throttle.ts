import type { ILogger } from './logger'

/**
 * Throttle para operaciones de sesión Signal que pueden causar loops
 */
export class SessionThrottle {
    private operationCounts = new Map<string, { count: number, lastReset: number }>()
    private logger: ILogger
    private readonly MAX_OPERATIONS_PER_MINUTE = 10
    private readonly RESET_INTERVAL = 60000 // 1 minuto

    constructor(logger: ILogger) {
        this.logger = logger
    }

    /**
     * Verifica si una operación debe ser throttled
     */
    shouldThrottle(operation: string, jid: string): boolean {
        const key = `${operation}:${jid}`
        const now = Date.now()

        let entry = this.operationCounts.get(key)

        if (!entry) {
            entry = { count: 0, lastReset: now }
            this.operationCounts.set(key, entry)
        }

        // Resetear contador si ha pasado el intervalo
        if (now - entry.lastReset > this.RESET_INTERVAL) {
            entry.count = 0
            entry.lastReset = now
        }

        entry.count++

        if (entry.count > this.MAX_OPERATIONS_PER_MINUTE) {
            this.logger.debug({
                operation,
                jid,
                count: entry.count
            }, 'throttling excessive session operation')
            return true
        }

        return false
    }

    /**
     * Limpia entradas antiguas
     */
    cleanup(): void {
        const now = Date.now()
        for (const [key, entry] of this.operationCounts.entries()) {
            if (now - entry.lastReset > this.RESET_INTERVAL * 2) {
                this.operationCounts.delete(key)
            }
        }
    }

    /**
     * Obtiene estadísticas
     */
    getStats(): { totalOperations: number, throttledOperations: number } {
        let totalOperations = 0
        let throttledOperations = 0

        for (const entry of this.operationCounts.values()) {
            totalOperations += entry.count
            if (entry.count > this.MAX_OPERATIONS_PER_MINUTE) {
                throttledOperations++
            }
        }

        return { totalOperations, throttledOperations }
    }
}

// Singleton para uso global
let globalSessionThrottle: SessionThrottle | null = null

export function getSessionThrottle(logger?: ILogger): SessionThrottle {
    if (!globalSessionThrottle && logger) {
        globalSessionThrottle = new SessionThrottle(logger)
    }
    return globalSessionThrottle!
}
