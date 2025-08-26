# 🚨 TROUBLESHOOTING: MENSAJES NO LLEGAN

## 🔍 **Diagnóstico Paso a Paso**

### **1. Verificar Estado del Mensaje**

```typescript
// Revisar el status del mensaje enviado
sock.ev.on("message-receipt.update", (update) => {
    console.log("Message receipt:", update);
    // Buscar tu mensaje por ID
});

// Al enviar mensaje, capturar el ID
const messageId = await sock.sendMessage(jid, { text: "test" });
console.log("Message ID:", messageId);
```

### **2. Verificar Logs de Envío**

```typescript
// Habilitar logging detallado
const sock = makeWASocket({
    logger: P({ level: "debug" }), // Máximo detalle
    printQRInTerminal: true,
});

// Buscar en logs:
// - "sent message to..."
// - "message acknowledged"
// - "delivery receipt"
```

### **3. Verificar JID del Destinatario**

```typescript
// Verificar que el JID sea correcto
const targetJid = "573217157710@s.whatsapp.net";
console.log("Sending to:", targetJid);

// Para usuarios LID, verificar ambos formatos
const lidJid = "573217157710@lid";
const phoneJid = "573217157710@s.whatsapp.net";

// Intentar con ambos si hay dudas
```

## 🎯 **Escenarios y Soluciones**

### **Escenario 1: Mensaje se Envía pero No Llega**

**Síntomas:**

- `sendMessage` retorna exitosamente
- No hay errores en logs
- Destinatario no recibe nada

**Diagnóstico:**

```typescript
sock.ev.on("messages.upsert", ({ messages }) => {
    messages.forEach((msg) => {
        if (msg.key.fromMe) {
            console.log("Mensaje saliente:", {
                to: msg.key.remoteJid,
                id: msg.key.id,
                status: msg.status, // PENDING, SENT, DELIVERED, READ
            });
        }
    });
});
```

**Soluciones:**

1. **Verificar conexión de destinatario**
2. **Revisar si JID está bloqueado**
3. **Verificar límites de WhatsApp**

### **Escenario 2: Error de Sesión/Encriptación**

**Síntomas:**

- Error "Bad MAC" o similares
- Mensajes fallan al encriptar
- Errores de sesión en logs

**Diagnóstico:**

```typescript
// Verificar sesiones disponibles
const sessions = await authState.keys.get("session", [targetJid]);
console.log("Sessions for", targetJid, ":", sessions);

// Para usuarios LID, verificar ambas sesiones
const lidSessions = await authState.keys.get("session", [lidJid]);
const phoneSessions = await authState.keys.get("session", [phoneJid]);
```

**Soluciones:**

```typescript
// 1. Limpiar sesión corrupta
await authState.keys.set({ "session": { [targetJid]: null } });

// 2. Forzar nueva sesión
await sock.sendMessage(targetJid, { text: "test" }, {
    force: true, // Fuerza nueva sesión
});

// 3. Para usuarios LID, usar JID correcto
if (isLidUser(originalJid)) {
    // Usar el JID que tenga sesión válida
    const hasLidSession = await hasSession(lidJid);
    const hasPhoneSession = await hasSession(phoneJid);

    const correctJid = hasLidSession ? lidJid : phoneJid;
    await sock.sendMessage(correctJid, message);
}
```

### **Escenario 3: Usuario LID Específico**

**Síntomas:**

- Funciona con usuarios normales
- Falla solo con usuarios @lid
- Conversaciones duplicadas

**Diagnóstico:**

```typescript
// Verificar si es usuario LID
const isLid = targetJid.includes("@lid");
console.log("Is LID user:", isLid);

// Verificar normalización
if (isLid) {
    const phoneJid = targetJid.replace("@lid", "@s.whatsapp.net");
    console.log("Phone equivalent:", phoneJid);

    // Verificar cuál tiene sesión
    const lidSession = await authState.keys.get("session", [targetJid]);
    const phoneSession = await authState.keys.get("session", [phoneJid]);

    console.log("LID session exists:", !!lidSession[targetJid]);
    console.log("Phone session exists:", !!phoneSession[phoneJid]);
}
```

**Soluciones:**

```typescript
// Usar la solución LID implementada
import { normalizeMessageJids } from "./src/Utils/jid-normalization";

const normalized = normalizeMessageJids(targetJid, undefined, senderPn);
await sock.sendMessage(normalized.chatId, message);
```

### **Escenario 4: Límites de WhatsApp**

**Síntomas:**

- Mensajes fallan después de cierta cantidad
- Error de rate limiting
- Cuenta temporalmente bloqueada

**Diagnóstico:**

```typescript
// Contar mensajes enviados
let messageCount = 0;
const startTime = Date.now();

sock.ev.on("messages.upsert", ({ messages }) => {
    messages.forEach((msg) => {
        if (msg.key.fromMe) {
            messageCount++;
            const elapsed = Date.now() - startTime;
            console.log(`Mensaje ${messageCount} en ${elapsed}ms`);
        }
    });
});
```

**Soluciones:**

```typescript
// 1. Implementar rate limiting
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendWithDelay(jid, message) {
    await sock.sendMessage(jid, message);
    await delay(2000); // 2 segundos entre mensajes
}

// 2. Batch processing
async function sendBatch(messages) {
    for (const [i, msg] of messages.entries()) {
        await sock.sendMessage(msg.jid, msg.content);

        // Pausa cada 10 mensajes
        if ((i + 1) % 10 === 0) {
            await delay(5000);
        }
    }
}
```

### **Escenario 5: Conexión/Estado del Socket**

**Síntomas:**

- Socket desconectado
- Mensajes quedan pendientes
- Errores de conexión

**Diagnóstico:**

```typescript
sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    console.log("Connection status:", connection);

    if (connection === "close") {
        console.log("Disconnect reason:", lastDisconnect?.error);
    }
});

// Verificar estado antes de enviar
if (sock.user) {
    console.log("Socket connected as:", sock.user.id);
} else {
    console.log("Socket not connected");
}
```

**Soluciones:**

```typescript
// 1. Esperar conexión antes de enviar
async function waitForConnection() {
    return new Promise((resolve) => {
        if (sock.user) {
            resolve(true);
        } else {
            sock.ev.once("connection.update", (update) => {
                if (update.connection === "open") {
                    resolve(true);
                }
            });
        }
    });
}

// 2. Usar antes de cada envío
await waitForConnection();
await sock.sendMessage(jid, message);
```

## 🛠️ **Herramientas de Diagnóstico**

### **1. Script de Diagnóstico Completo**

```typescript
async function diagnoseMsgDelivery(targetJid: string) {
    console.log("=== DIAGNÓSTICO DE ENTREGA ===");

    // 1. Estado del socket
    console.log("Socket connected:", !!sock.user);
    console.log("My JID:", sock.user?.id);

    // 2. Verificar JID target
    console.log("Target JID:", targetJid);
    console.log("Is LID:", targetJid.includes("@lid"));

    // 3. Verificar sesiones
    const sessions = await authState.keys.get("session", [targetJid]);
    console.log("Has session:", !!sessions[targetJid]);

    // 4. Para LID, verificar alternativas
    if (targetJid.includes("@lid")) {
        const phoneJid = targetJid.replace("@lid", "@s.whatsapp.net");
        const phoneSessions = await authState.keys.get("session", [phoneJid]);
        console.log("Phone JID alternative:", phoneJid);
        console.log("Has phone session:", !!phoneSessions[phoneJid]);
    }

    // 5. Intentar envío de prueba
    try {
        const result = await sock.sendMessage(targetJid, {
            text: "Test message - " + new Date().toISOString(),
        });
        console.log("Send result:", result);
        return result;
    } catch (error) {
        console.error("Send error:", error);
        return null;
    }
}

// Usar así:
await diagnoseMsgDelivery("573217157710@s.whatsapp.net");
```

### **2. Monitor de Entrega en Tiempo Real**

```typescript
function setupDeliveryMonitor() {
    const pendingMessages = new Map();

    // Capturar mensajes salientes
    sock.ev.on("messages.upsert", ({ messages }) => {
        messages.forEach((msg) => {
            if (msg.key.fromMe && msg.key.id) {
                pendingMessages.set(msg.key.id, {
                    to: msg.key.remoteJid,
                    timestamp: Date.now(),
                    status: "SENT",
                });
                console.log(`📤 Enviado: ${msg.key.id} → ${msg.key.remoteJid}`);
            }
        });
    });

    // Capturar confirmaciones
    sock.ev.on("message-receipt.update", (receipts) => {
        receipts.forEach((receipt) => {
            const pending = pendingMessages.get(receipt.key.id);
            if (pending) {
                const elapsed = Date.now() - pending.timestamp;
                console.log(`✅ Confirmado: ${receipt.key.id} en ${elapsed}ms`);
                pendingMessages.delete(receipt.key.id);
            }
        });
    });

    // Revisar pendientes cada 30 segundos
    setInterval(() => {
        const now = Date.now();
        for (const [id, msg] of pendingMessages.entries()) {
            const elapsed = now - msg.timestamp;
            if (elapsed > 30000) { // 30 segundos
                console.log(`⏰ Pendiente: ${id} → ${msg.to} (${elapsed}ms)`);
            }
        }
    }, 30000);
}
```

## 🎯 **Checklist de Resolución**

### **Verificaciones Básicas:**

- [ ] Socket está conectado
- [ ] JID del destinatario es correcto
- [ ] Hay sesión válida para el destinatario
- [ ] No hay errores en logs

### **Para Usuarios LID:**

- [ ] Verificar si es usuario @lid
- [ ] Comprobar ambos JIDs (lid y phone)
- [ ] Usar JID con sesión válida
- [ ] Verificar normalización de chat

### **Para Problemas de Sesión:**

- [ ] Limpiar sesión corrupta
- [ ] Forzar nueva sesión
- [ ] Verificar claves pre-key
- [ ] Revisar identity keys

### **Para Rate Limiting:**

- [ ] Implementar delays entre mensajes
- [ ] Monitorear cantidad de mensajes
- [ ] Usar batch processing
- [ ] Verificar límites de WhatsApp

## 🚀 **Solución Rápida**

```typescript
// Función todo-en-uno para envío robusto
async function sendMessageRobust(jid: string, message: any, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`Intento ${attempt} enviando a ${jid}`);

            // Verificar conexión
            if (!sock.user) {
                await waitForConnection();
            }

            // Para usuarios LID, usar JID correcto
            let targetJid = jid;
            if (jid.includes("@lid")) {
                const phoneJid = jid.replace("@lid", "@s.whatsapp.net");
                const hasLidSession = await hasSession(jid);
                const hasPhoneSession = await hasSession(phoneJid);

                targetJid = hasLidSession
                    ? jid
                    : (hasPhoneSession ? phoneJid : jid);
                console.log(`Usuario LID: usando ${targetJid}`);
            }

            // Enviar mensaje
            const result = await sock.sendMessage(targetJid, message);
            console.log(`✅ Enviado exitosamente: ${result}`);
            return result;
        } catch (error) {
            console.error(`❌ Intento ${attempt} falló:`, error);

            if (attempt === retries) {
                throw error;
            }

            // Limpiar sesión si es error de MAC
            if (error.message?.includes("Bad MAC")) {
                await authState.keys.set({ "session": { [jid]: null } });
                console.log("🧹 Sesión limpiada, reintentando...");
            }

            // Esperar antes del siguiente intento
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
    }
}
```

**¿Cuál de estos escenarios describe mejor tu problema actual?**
