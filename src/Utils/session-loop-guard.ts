import type { ILogger } from './logger'

interface SessionActivity {
    lastActivity: number
    closeCount: number
}

/**
 * Previene loops infinitos de cierre de sesiones
 */
export class SessionLoopGuard {
    private sessionActivity = new Map<string, SessionActivity>()
    private logger: ILogger
    private readonly LOOP_THRESHOLD = 5 // Max closes per minute
    private readonly ACTIVITY_WINDOW = 60000 // 1 minuto

    constructor(logger: ILogger) {
        this.logger = logger
    }

    /**
     * Verifica si una sesión está en loop y debe ser ignorada
     */
    shouldPreventSessionClose(jid: string): boolean {
        const now = Date.now()
        const activity = this.sessionActivity.get(jid)

        if (!activity) {
            // Primera vez - permitir
            this.sessionActivity.set(jid, {
                lastActivity: now,
                closeCount: 1
            })
            return false
        }

        // Si ha pasado más de 1 minuto, resetear contador
        if (now - activity.lastActivity > this.ACTIVITY_WINDOW) {
            this.sessionActivity.set(jid, {
                lastActivity: now,
                closeCount: 1
            })
            return false
        }

        // Incrementar contador
        activity.closeCount++
        activity.lastActivity = now

        // Si excede el threshold, prevenir
        if (activity.closeCount > this.LOOP_THRESHOLD) {
            this.logger.warn({
                jid,
                closeCount: activity.closeCount
            }, 'session close loop detected - preventing further closes')
            return true
        }

        return false
    }

    /**
     * Marca una sesión como estable (resetea contador)
     */
    markSessionStable(jid: string): void {
        this.sessionActivity.delete(jid)
    }

    /**
     * Limpia actividad antigua
     */
    cleanup(): void {
        const now = Date.now()
        for (const [jid, activity] of this.sessionActivity.entries()) {
            if (now - activity.lastActivity > this.ACTIVITY_WINDOW * 2) {
                this.sessionActivity.delete(jid)
            }
        }
    }

    /**
     * Obtiene estadísticas de actividad
     */
    getStats(): { totalSessions: number, loopingSessions: number } {
        const now = Date.now()
        let loopingSessions = 0

        for (const activity of this.sessionActivity.values()) {
            if (now - activity.lastActivity <= this.ACTIVITY_WINDOW &&
                activity.closeCount > this.LOOP_THRESHOLD) {
                loopingSessions++
            }
        }

        return {
            totalSessions: this.sessionActivity.size,
            loopingSessions
        }
    }
}
