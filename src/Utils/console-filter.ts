/**
 * Filtro para logs de consola que pueden causar spam
 */

const originalConsoleLog = console.log
const originalConsoleWarn = console.warn
const originalConsoleError = console.error
const originalConsoleInfo = console.info
const originalConsoleDebug = console.debug

// También interceptar process.stdout y process.stderr
const originalStdoutWrite = process.stdout.write
const originalStderrWrite = process.stderr.write

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

function filterStreamWrite(this: any, originalWrite: Function, chunk: any, encoding?: any, callback?: any) {
    if (typeof chunk === 'string' && shouldFilter(chunk)) {
        // Filtrar el chunk
        if (process.env.DEBUG_SESSION_LOGS === 'true') {
            return originalWrite.call(this, '[SESSION] Filtered\n', encoding, callback)
        }
        // No escribir nada
        if (callback) callback()
        return true
    }

    // Escribir normalmente
    return originalWrite.call(this, chunk, encoding, callback)
}

/**
 * Instala el filtro de logs
 */
export function installConsoleFilter(): void {
    console.log = (...args) => filterLogMessage(originalConsoleLog, ...args)
    console.warn = (...args) => filterLogMessage(originalConsoleWarn, ...args)
    console.error = (...args) => filterLogMessage(originalConsoleError, ...args)
    console.info = (...args) => filterLogMessage(originalConsoleInfo, ...args)
    console.debug = (...args) => filterLogMessage(originalConsoleDebug, ...args)

    // Interceptar streams también
    process.stdout.write = function (chunk: any, encoding?: any, callback?: any) {
        return filterStreamWrite.call(this, originalStdoutWrite, chunk, encoding, callback)
    }
    process.stderr.write = function (chunk: any, encoding?: any, callback?: any) {
        return filterStreamWrite.call(this, originalStderrWrite, chunk, encoding, callback)
    }
}

/**
 * Restaura el comportamiento original de console
 */
export function uninstallConsoleFilter(): void {
    console.log = originalConsoleLog
    console.warn = originalConsoleWarn
    console.error = originalConsoleError
    console.info = originalConsoleInfo
    console.debug = originalConsoleDebug

    // Restaurar streams
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
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
