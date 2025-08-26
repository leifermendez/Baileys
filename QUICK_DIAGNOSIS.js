// DIAGNÓSTICO RÁPIDO - Ejecutar esto primero
async function quickDiagnosis(sock, targetJid) {
    console.log('🔍 DIAGNÓSTICO RÁPIDO DE ENTREGA')
    console.log('================================')
    
    // 1. Estado básico
    console.log('✅ Socket conectado:', !!sock.user)
    console.log('📱 Mi JID:', sock.user?.id)
    console.log('🎯 Target JID:', targetJid)
    console.log('🔗 Es usuario LID:', targetJid.includes('@lid'))
    
    // 2. Verificar sesiones
    try {
        const sessions = await sock.authState.keys.get('session', [targetJid])
        console.log('🔐 Tiene sesión:', !!sessions[targetJid])
        
        // Para usuarios LID, verificar alternativa
        if (targetJid.includes('@lid')) {
            const phoneJid = targetJid.replace('@lid', '@s.whatsapp.net')
            const phoneSessions = await sock.authState.keys.get('session', [phoneJid])
            console.log('📞 JID alternativo:', phoneJid)
            console.log('🔐 Sesión alternativa:', !!phoneSessions[phoneJid])
        }
    } catch (error) {
        console.error('❌ Error verificando sesiones:', error)
    }
    
    // 3. Test de envío
    console.log('\n📤 PROBANDO ENVÍO...')
    try {
        const testMessage = `Test ${new Date().toISOString()}`
        const result = await sock.sendMessage(targetJid, { text: testMessage })
        console.log('✅ Mensaje enviado:', result)
        
        // Monitorear confirmación por 10 segundos
        let confirmed = false
        const timeout = setTimeout(() => {
            if (!confirmed) {
                console.log('⏰ Sin confirmación en 10 segundos')
            }
        }, 10000)
        
        sock.ev.once('message-receipt.update', (receipts) => {
            const receipt = receipts.find(r => r.key.id === result)
            if (receipt) {
                confirmed = true
                clearTimeout(timeout)
                console.log('✅ CONFIRMADO: Mensaje entregado')
            }
        })
        
        return result
    } catch (error) {
        console.error('❌ ERROR AL ENVIAR:', error.message)
        return null
    }
}

// USO:
// await quickDiagnosis(sock, '573217157710@s.whatsapp.net')
// await quickDiagnosis(sock, '573217157710@lid')
