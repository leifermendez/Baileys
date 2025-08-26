/**
 * Filtro para logs de consola que pueden causar spam
 */

const originalConsoleLog = console.log
const originalConsoleWarn = console.warn
const originalConsoleError = console.error

// Patrones a filtrar
const SPAM_PATTERNS = [
    /Closing stale open session for new outgoing prekey bundle/,
    /Closing session: SessionEntry/,
    /Session error:Error: Bad MAC Error: Bad MAC/,
    /Failed to decrypt message with any known session/
]

function shouldFilter(message: string): boolean {
    return SPAM_PATTERNS.some(pattern => pattern.test(message))
}

function filterLogMessage(originalFn: Function, ...args: any[]) {
    const message = args.join(' ')

    // Si el mensaje contiene patrones de spam, filtrarlo
    if (shouldFilter(message)) {
        // Solo mostrar una versión simplificada en debug
        if (process.env.DEBUG_SESSION_LOGS === 'true') {
            originalFn('[SESSION]', 'Session operation (filtered)')
        }
        return
    }

    // Mensaje normal - permitir
    originalFn(...args)
}

/**
 * Instala el filtro de logs
 */
export function installConsoleFilter(): void {
    console.log = (...args) => filterLogMessage(originalConsoleLog, ...args)
    console.warn = (...args) => filterLogMessage(originalConsoleWarn, ...args)
    console.error = (...args) => filterLogMessage(originalConsoleError, ...args)
}

/**
 * Restaura el comportamiento original de console
 */
export function uninstallConsoleFilter(): void {
    console.log = originalConsoleLog
    console.warn = originalConsoleWarn
    console.error = originalConsoleError
}

/**
 * Filtro temporal por tiempo
 */
export function installTemporaryFilter(durationMs: number = 30000): void {
    installConsoleFilter()

    setTimeout(() => {
        uninstallConsoleFilter()
    }, durationMs)
}
