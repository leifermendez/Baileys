import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type { SignalRepository, WAMessage, WAMessageKey } from '../Types'
import {
	areJidsSameUser,
	type BinaryNode,
	isJidBroadcast,
	isJidGroup,
	isJidMetaIa,
	isJidNewsletter,
	isJidStatusBroadcast,
	isJidUser,
	isLidUser,
	jidNormalizedUser
} from '../WABinary'
import { normalizeMessageJids } from './jid-normalization'
import { unpadRandomMax16 } from './generics'
import type { ILogger } from './logger'

export const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node'
export const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled'

export const NACK_REASONS = {
	ParsingError: 487,
	UnrecognizedStanza: 488,
	UnrecognizedStanzaClass: 489,
	UnrecognizedStanzaType: 490,
	InvalidProtobuf: 491,
	InvalidHostedCompanionStanza: 493,
	MissingMessageSecret: 495,
	SignalErrorOldCounter: 496,
	MessageDeletedOnPeer: 499,
	UnhandledError: 500,
	UnsupportedAdminRevoke: 550,
	UnsupportedLIDGroup: 551,
	DBOperationFailed: 552
}

type MessageType =
	| 'chat'
	| 'peer_broadcast'
	| 'other_broadcast'
	| 'group'
	| 'direct_peer_status'
	| 'other_status'
	| 'newsletter'

/**
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
export function decodeMessageNode(stanza: BinaryNode, meId: string, meLid: string) {
	let msgType: MessageType
	let chatId: string
	let author: string

	const msgId = stanza.attrs.id
	const from = stanza.attrs.from
	const participant: string | undefined = stanza.attrs.participant
	const recipient: string | undefined = stanza.attrs.recipient

	const isMe = (jid: string) => areJidsSameUser(jid, meId)
	const isMeLid = (jid: string) => areJidsSameUser(jid, meLid)

	if (isJidUser(from) || isLidUser(from)) {
		if (recipient && !isJidMetaIa(recipient)) {
			if (!isMe(from!) && !isMeLid(from!)) {
				throw new Boom('receipient present, but msg not from me', { data: stanza })
			}

			chatId = recipient
		} else {
			// Revertir a normalización robusta para evitar chats duplicados
			const normalized = normalizeMessageJids(from!, participant, stanza.attrs.sender_pn)
			chatId = normalized.chatId
		}

		msgType = 'chat'
		author = from!
	} else if (isJidGroup(from)) {
		if (!participant) {
			throw new Boom('No participant in group message')
		}

		msgType = 'group'
		author = participant
		chatId = from!
	} else if (isJidBroadcast(from)) {
		if (!participant) {
			throw new Boom('No participant in group message')
		}

		const isParticipantMe = isMe(participant)
		if (isJidStatusBroadcast(from!)) {
			msgType = isParticipantMe ? 'direct_peer_status' : 'other_status'
		} else {
			msgType = isParticipantMe ? 'peer_broadcast' : 'other_broadcast'
		}

		chatId = from!
		author = participant
	} else if (isJidNewsletter(from)) {
		msgType = 'newsletter'
		chatId = from!
		author = from!
	} else {
		throw new Boom('Unknown message type', { data: stanza })
	}

	const fromMe = (isLidUser(from) ? isMeLid : isMe)((stanza.attrs.participant || stanza.attrs.from)!)
	const pushname = stanza?.attrs?.notify

	const key: WAMessageKey = {
		remoteJid: chatId,
		fromMe,
		id: msgId,
		senderLid: stanza?.attrs?.sender_lid,
		senderPn: stanza?.attrs?.sender_pn,
		participant,
		participantPn: stanza?.attrs?.participant_pn,
		participantLid: stanza?.attrs?.participant_lid,
		...(msgType === 'newsletter' && stanza.attrs.server_id ? { server_id: stanza.attrs.server_id } : {})
	}

	const fullMessage: WAMessage = {
		key,
		messageTimestamp: +stanza.attrs.t!,
		pushName: pushname,
		broadcast: isJidBroadcast(from)
	}

	if (key.fromMe) {
		fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK
	}

	return {
		fullMessage,
		author,
		sender: msgType === 'chat' ? author : chatId
	}
}

export const decryptMessageNode = (
	stanza: BinaryNode,
	meId: string,
	meLid: string,
	repository: SignalRepository,
	logger: ILogger
) => {
	const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid)
	return {
		fullMessage,
		category: stanza.attrs.category,
		author,
		async decrypt() {
			let decryptables = 0
			if (Array.isArray(stanza.content)) {
				for (const { tag, attrs, content } of stanza.content) {
					if (tag === 'verified_name' && content instanceof Uint8Array) {
						const cert = proto.VerifiedNameCertificate.decode(content)
						const details = proto.VerifiedNameCertificate.Details.decode(cert.details!)
						fullMessage.verifiedBizName = details.verifiedName
					}

					if (tag === 'unavailable' && attrs.type === 'view_once') {
						fullMessage.key.isViewOnce = true
					}

					if (tag !== 'enc' && tag !== 'plaintext') {
						continue
					}

					if (!(content instanceof Uint8Array)) {
						continue
					}

					decryptables += 1

					let msgBuffer: Uint8Array

					try {
						const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type
						switch (e2eType) {
							case 'skmsg':
								msgBuffer = await repository.decryptGroupMessage({
									group: sender,
									authorJid: author,
									msg: content
								})
								break
							case 'pkmsg':
							case 'msg':
								// Manejo robusto de JID para desencriptación
								let user = isJidUser(sender) ? sender : author
								let recoveryAttempted = false

								// Usar normalización robusta para crypto JID (evita inconsistencias)
								if (stanza.attrs.original_from && isLidUser(stanza.attrs.original_from)) {
									const normalized = normalizeMessageJids(
										stanza.attrs.original_from,
										author,
										stanza.attrs.sender_pn
									)
									user = normalized.cryptoJid
									if (logger.level === 'debug') {
										logger.debug({ cryptoJid: user, chatId: normalized.chatId }, 'using normalized LID JIDs')
									}
								}

								try {
									msgBuffer = await repository.decryptMessage({
										jid: user,
										type: e2eType,
										ciphertext: content
									})
								} catch (decryptError: any) {
									// Recovery automático mejorado
									if (decryptError.message?.includes('Bad MAC') && !recoveryAttempted) {
										recoveryAttempted = true
										logger.debug({ originalUser: user, error: decryptError.message }, 'attempting decryption recovery')

										// Para usuarios LID, intentar múltiples estrategias
										if (stanza.attrs.original_from && isLidUser(stanza.attrs.original_from)) {
											const lidJid = stanza.attrs.original_from
											const phoneJid = stanza.attrs.sender_pn

											// Estrategia 1: Si estábamos usando normalizado, intentar con original
											if (user !== lidJid) {
												try {
													logger.debug({ trying: lidJid }, 'trying original LID JID')
													msgBuffer = await repository.decryptMessage({
														jid: lidJid,
														type: e2eType,
														ciphertext: content
													})
													logger.debug({ recoveredWith: lidJid }, 'recovered with original LID')
													break // Salir del switch
												} catch (lidError: any) {
													logger.debug({ lidJid, error: lidError.message }, 'original LID failed')
												}
											}

											// Estrategia 2: Intentar con phone number si está disponible
											if (phoneJid && phoneJid !== user) {
												try {
													logger.debug({ trying: phoneJid }, 'trying phone number fallback')
													msgBuffer = await repository.decryptMessage({
														jid: phoneJid,
														type: e2eType,
														ciphertext: content
													})
													logger.debug({ recoveredWith: phoneJid }, 'recovered with phone number')
													break // Salir del switch
												} catch (phoneError: any) {
													logger.debug({ phoneJid, error: phoneError.message }, 'phone number fallback failed')
												}
											}
										}

										// Si llegamos aquí, todos los intentos fallaron
										logger.warn({
											user,
											originalFrom: stanza.attrs.original_from,
											senderPn: stanza.attrs.sender_pn
										}, 'all decryption recovery attempts failed')
										throw decryptError
									} else {
										throw decryptError
									}
								}
								break
							case 'plaintext':
								msgBuffer = content
								break
							default:
								throw new Error(`Unknown e2e type: ${e2eType}`)
						}

						let msg: proto.IMessage = proto.Message.decode(
							e2eType !== 'plaintext' ? unpadRandomMax16(msgBuffer) : msgBuffer
						)
						msg = msg.deviceSentMessage?.message || msg
						if (msg.senderKeyDistributionMessage) {
							//eslint-disable-next-line max-depth
							try {
								await repository.processSenderKeyDistributionMessage({
									authorJid: author,
									item: msg.senderKeyDistributionMessage
								})
							} catch (err) {
								logger.debug({ key: fullMessage.key }, 'sender key processing skipped')
							}
						}

						if (fullMessage.message) {
							Object.assign(fullMessage.message, msg)
						} else {
							fullMessage.message = msg
						}
					} catch (err: any) {
						// Logging mejorado para diagnosticar mensajes undefined
						const isLidMessage = stanza.attrs.original_from && stanza.attrs.original_from.includes('@lid')

						if (isLidMessage) {
							logger.warn({
								key: fullMessage.key,
								originalFrom: stanza.attrs.original_from,
								senderPn: stanza.attrs.sender_pn,
								error: err.message
							}, 'LID message decryption failed - will appear as undefined')
						} else {
							logger.debug({ key: fullMessage.key }, 'message decryption skipped')
						}

						fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
						fullMessage.messageStubParameters = ['Decryption error']
					}
				}
			}

			// if nothing was found to decrypt
			if (!decryptables) {
				fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
				fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT]
			}
		}
	}
}
