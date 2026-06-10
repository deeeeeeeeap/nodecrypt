// Room management logic for NodeCrypt web client
// NodeCrypt 网页客户端的房间管理逻辑

import {
	createAvatarSVG
} from './util.avatar.js';
import {
	renderChatArea,
	addSystemMsg,
	updateChatInputStyle
} from './chat.js';
import {
	renderMainHeader,
	renderUserList
} from './ui.js';
import {
	escapeHTML
} from './util.string.js';
import {
	$id,
	createElement
} from './util.dom.js';
import {
	resumePendingFileRepairs
} from './util.file.js';
import {
	appendMessage
} from './chat.logic.js';
import { t } from './util.i18n.js';
let roomsData = [];
let activeRoomIndex = -1;

function removePendingRoom(roomData) {
	const index = roomsData.indexOf(roomData);
	if (index === -1) return;
	const chatInst = roomData.chat;
	if (chatInst && typeof chatInst.destruct === 'function') {
		chatInst.destruct()
	} else if (chatInst && typeof chatInst.disconnect === 'function') {
		chatInst.disconnect()
	}
	roomsData.splice(index, 1);
	if (activeRoomIndex === index) {
		if (roomsData.length > 0) {
			switchRoom(Math.min(index, roomsData.length - 1))
		} else {
			activeRoomIndex = -1;
			renderRooms(-1)
		}
	} else if (activeRoomIndex > index) {
		activeRoomIndex -= 1
	}
}

// Get a new room data object
// 获取一个新的房间数据对象
export function getNewRoomData() {
	return {
		roomName: '',
		userList: [],
		userMap: {},
		myId: null,
		myUserName: '',
		chat: null,
		messages: [],
		prevUserList: [],
		knownUserIds: new Set(),
		rawUserIds: new Set(),
		historyIds: new Set(),
		unreadCount: 0,
		privateChatTargetId: null,
		privateChatTargetName: null,
		connectionStatus: 'offline',
		connectionStatusText: '',
		reconnectAttempt: 0,
		hasConnectedBefore: false
	}
}

function setRoomConnectionStatus(idx, status, details = {}) {
	const rd = roomsData[idx];
	if (!rd) return;
	const previousStatus = rd.connectionStatus;
	const addConnectionMessage = (text) => {
		const timestamp = Date.now();
		appendMessage(rd.messages, {
			type: 'system',
			text,
			timestamp
		});
		if (activeRoomIndex === idx) {
			addSystemMsg(text, true, timestamp)
		}
	};
	rd.connectionStatus = status;
	rd.reconnectAttempt = details.attempt || 0;
	if (status === 'connected') {
		rd.connectionStatusText = t('ui.connection_connected', 'Connected');
		if (previousStatus !== 'connected') {
			addConnectionMessage(rd.hasConnectedBefore ?
				t('system.connection_restored', 'Connection restored') :
				t('system.secured', 'connection secured')
			);
		}
		rd.hasConnectedBefore = true
	} else if (status === 'reconnecting') {
		rd.connectionStatusText = t('ui.connection_reconnecting', 'Reconnecting');
		if (previousStatus !== 'reconnecting' && previousStatus !== 'connecting') {
			addConnectionMessage(t('system.connection_reconnecting', 'Connection lost. Reconnecting...'))
		}
	} else if (status === 'connecting') {
		rd.connectionStatusText = t('ui.connection_connecting', 'Connecting')
	} else {
		rd.connectionStatusText = t('ui.connection_offline', 'Offline');
		if (previousStatus !== 'offline' && previousStatus !== 'reconnecting') {
			addConnectionMessage(t('system.connection_closed', 'Node connection closed'))
		}
	}
	if (activeRoomIndex === idx) {
		renderMainHeader()
	}
}

// Switch to another room by index
// 切换到指定索引的房间
export function switchRoom(index) {
	if (index < 0 || index >= roomsData.length) return;
	activeRoomIndex = index;
	const rd = roomsData[index];
	if (typeof rd.unreadCount === 'number') rd.unreadCount = 0;
	const sidebarUsername = document.getElementById('sidebar-username');
	if (sidebarUsername) sidebarUsername.textContent = rd.myUserName;
	setSidebarAvatar(rd.myUserName);
	renderRooms(index);
	renderMainHeader();
	renderUserList(false);
	renderChatArea();
	updateChatInputStyle()
}

// Set the sidebar avatar
// 设置侧边栏头像
export function setSidebarAvatar(userName) {
	if (!userName) return;
	const el = $id('sidebar-user-avatar');
	if (el) {
		el.innerHTML = createAvatarSVG(userName)
	}
}

// Render the room list
// 渲染房间列表
export function renderRooms(activeId = 0) {
	const roomList = $id('room-list');
	roomList.innerHTML = '';
	roomsData.forEach((rd, i) => {
		const div = createElement('div', {
			class: 'room' + (i === activeId ? ' active' : ''),
			onclick: () => switchRoom(i)
		});
		const safeRoomName = escapeHTML(rd.roomName);
		let unreadHtml = '';
		if (rd.unreadCount && i !== activeId) {
			unreadHtml = `<span class="room-unread-badge">${rd.unreadCount>99?'99+':rd.unreadCount}</span>`
		}
		div.innerHTML = `<div class="info"><div class="title">#${safeRoomName}</div></div>${unreadHtml}`;
		roomList.appendChild(div)
	})
}

// Join a room
// 加入一个房间
export function joinRoom(userName, roomName, password, modal = null, onResult) {
	const newRd = getNewRoomData();
	newRd.roomName = roomName;
	newRd.myUserName = userName;
	newRd.password = password;
	newRd.connectionStatus = 'connecting';
	newRd.connectionStatusText = t('ui.connection_connecting', 'Connecting');
	roomsData.push(newRd);
	const idx = roomsData.length - 1;
	switchRoom(idx);
	const sidebarUsername = $id('sidebar-username');
	if (sidebarUsername) sidebarUsername.textContent = userName;
	setSidebarAvatar(userName);
	let closed = false;
	const callbacks = {
		onServerClosed: () => {
			if (onResult && !closed) {
				closed = true;
				onResult(false)
			}
		},
		onServerKeyChanged: () => {
			const trusted = window.confirm(t(
				'system.server_key_changed_confirm',
				'The server identity key changed. This can happen after a server redeploy, but it can also indicate interception. Trust the new key?'
			));

			addSystemMsg(trusted ?
				t('system.server_key_accepted', 'New server identity key trusted') :
				t('system.server_key_rejected', 'Server identity key rejected')
			);

			return trusted
		},
		onServerTrustError: () => {
			addSystemMsg(t('system.server_trust_error', 'Server identity verification failed'))
		},
		onServerSecured: () => {
			if (modal) modal.remove();
			else {
				const loginContainer = $id('login-container');
				if (loginContainer) loginContainer.style.display = 'none';
				const chatContainer = $id('chat-container');
				if (chatContainer) chatContainer.style.display = '';
				document.body.classList.remove('login-page');
				

			}
			if (onResult && !closed) {
				closed = true;
				onResult(true)
			}
		},
		onConnectionStatus: (status, details) => setRoomConnectionStatus(idx, status, details),
		onClientSecured: (user) => handleClientSecured(idx, user),
		onClientList: (list, selfId, rawClientIds) => handleClientList(idx, list, selfId, rawClientIds),
		onClientLeft: (clientId) => handleClientLeft(idx, clientId),
		onClientMessage: (msg) => handleClientMessage(idx, msg),
		onHistoryMessages: (messages) => handleHistoryMessages(idx, messages)
	};
	const chatInst = new window.NodeCrypt(window.config, callbacks);
	roomsData[idx].chat = chatInst;
	const hasCredentials = chatInst.setCredentials(userName, roomName, password);
	const connected = hasCredentials && chatInst.connect();
	if (!connected && onResult && !closed) {
		removePendingRoom(newRd);
		closed = true;
		onResult(false)
	}
	return {
		cancel: () => removePendingRoom(newRd)
	}
}

// Handle the client list update
// 处理客户端列表更新
export function handleClientList(idx, list, selfId, rawClientIds = null) {
	const rd = roomsData[idx];
	if (!rd) return;
	const oldUserIds = new Set((rd.userList || []).map(u => u.clientId));
	const previousAuthoritativeIds = rd.rawUserIds instanceof Set ? rd.rawUserIds : oldUserIds;
	const newUserIds = new Set(list.map(u => u.clientId));
	const authoritativeUserIds = Array.isArray(rawClientIds) ? new Set(rawClientIds) : newUserIds;
	for (const oldId of previousAuthoritativeIds) {
		if (!authoritativeUserIds.has(oldId)) {
			handleClientLeft(idx, oldId)
		}
	}
	rd.rawUserIds = authoritativeUserIds;
	rd.userList = list;
	rd.userMap = {};
	list.forEach(u => {
		rd.userMap[u.clientId] = u
	});
	rd.myId = selfId;
	if (activeRoomIndex === idx) {
		renderUserList(false);
		renderMainHeader()
	}
	rd.initCount = (rd.initCount || 0) + 1;
	if (rd.initCount === 2) {
		rd.isInitialized = true;
		rd.knownUserIds = new Set(list.map(u => u.clientId))
	}
	list.forEach(user => resumeRoomFileRepairs(idx, user))
}

function formatHistoryLoadedMessage(count) {
	return t('system.history_loaded_count', '{count} historical messages loaded').replace('{count}', count)
}

function getRoomUserName(user) {
	return user ? (user.userName || user.username || user.name || '') : ''
}

function resumeRoomFileRepairs(idx, user) {
	const rd = roomsData[idx];
	if (!rd || !user || !user.clientId) return;
	const userName = getRoomUserName(user);
	if (!userName) return;
	const sameNameCount = (rd.userList || []).filter(candidate => getRoomUserName(candidate) === userName).length;
	if (sameNameCount > 1) return;
	resumePendingFileRepairs({
		roomIndex: idx,
		clientId: user.clientId,
		userName,
		isConnectionOpen: () => Boolean(rd.chat && typeof rd.chat.isOpen === 'function' && rd.chat.isOpen()),
		sendClientMessage: (targetClientId, type, data) => {
			if (!rd.chat || typeof rd.chat.sendClientMessage !== 'function') {
				return false
			}
			return rd.chat.sendClientMessage(targetClientId, type, data)
		}
	})
}

// Handle temporary encrypted room history from the relay.
// 处理由中继端缓存的临时加密房间历史。
export function handleHistoryMessages(idx, messages) {
	const rd = roomsData[idx];
	if (!rd || !Array.isArray(messages)) return;
	if (!rd.historyIds) {
		rd.historyIds = new Set()
	}

	const sortedMessages = messages.slice().sort((a, b) => a.ts - b.ts);
	let added = 0;

	for (const msg of sortedMessages) {
		if (!msg || rd.historyIds.has(msg.id)) continue;

		rd.historyIds.add(msg.id);
		appendMessage(rd.messages, {
			type: msg.u === rd.myUserName ? 'me' : 'other',
			text: msg.d,
			userName: msg.u,
			avatar: msg.u,
			msgType: 'text',
			timestamp: msg.ts,
			historyId: msg.id
		});
		added += 1
	}

	if (added > 0 && activeRoomIndex === idx) {
		renderChatArea();
		addSystemMsg(formatHistoryLoadedMessage(added))
	}
}

// Handle client secured event
// 处理客户端安全连接事件
export function handleClientSecured(idx, user) {
	const rd = roomsData[idx];
	if (!rd) return;
	rd.userMap[user.clientId] = user;
	const existingUserIndex = rd.userList.findIndex(u => u.clientId === user.clientId);
	if (existingUserIndex === -1) {
		rd.userList.push(user)
	} else {
		rd.userList[existingUserIndex] = user
	}
	if (activeRoomIndex === idx) {
		renderUserList(false);
		renderMainHeader()
	}
	resumeRoomFileRepairs(idx, user);
	if (!rd.isInitialized) {
		return
	}
	const isNew = !rd.knownUserIds.has(user.clientId);
	if (isNew) {
		rd.knownUserIds.add(user.clientId);		const name = user.userName || user.username || user.name || t('ui.anonymous', 'Anonymous');
		const msg = `${name} ${t('system.joined', 'joined the conversation')}`;
		appendMessage(rd.messages, {
			type: 'system',
			text: msg
		});
		if (activeRoomIndex === idx) addSystemMsg(msg, true);
		if (window.notifyMessage) {
			window.notifyMessage(rd.roomName, 'system', msg)
		}
	}
}

// Handle client left event
// 处理客户端离开事件
export function handleClientLeft(idx, clientId) {
	const rd = roomsData[idx];
	if (!rd) return;
	const user = rd.userMap[clientId];
	const wasPrivateTarget = rd.privateChatTargetId === clientId;
	if (wasPrivateTarget) {
		rd.privateChatTargetId = null;
		rd.privateChatTargetName = null;
		if (activeRoomIndex === idx) {
			updateChatInputStyle()
		}
	}
	if (!user && !wasPrivateTarget) {
		rd.userList = rd.userList.filter(u => u.clientId !== clientId);
		delete rd.userMap[clientId];
		if (rd.rawUserIds instanceof Set) {
			rd.rawUserIds.delete(clientId)
		}
		if (activeRoomIndex === idx) {
			renderUserList(false);
			renderMainHeader()
		}
		return
	}
	const name = user ? (user.userName || user.username || user.name || 'Anonymous') : 'Anonymous';
	const msg = `${name} ${t('system.left', 'left the conversation')}`;
	appendMessage(rd.messages, {
		type: 'system',
		text: msg
	});
	if (activeRoomIndex === idx) addSystemMsg(msg, true);
	rd.userList = rd.userList.filter(u => u.clientId !== clientId);
	delete rd.userMap[clientId];
	if (rd.rawUserIds instanceof Set) {
		rd.rawUserIds.delete(clientId)
	}
	if (activeRoomIndex === idx) {
		renderUserList(false);
		renderMainHeader()
	}
}

// Handle client message event
// 处理客户端消息事件
export function handleClientMessage(idx, msg) {
	const newRd = roomsData[idx];
	if (!newRd) return;

	// Prevent processing own messages unless it's a private message sent to oneself
	if (msg.clientId === newRd.myId && msg.userName === newRd.myUserName && !msg.type.includes('_private')) {
		return;
	}

	let msgType = msg.type || 'text';

	// Handle file messages
	if (msgType.startsWith('file_')) {
		let realUserName = msg.userName;
		if (!realUserName && msg.clientId && newRd.userMap[msg.clientId]) {
			realUserName = newRd.userMap[msg.clientId].userName || newRd.userMap[msg.clientId].username || newRd.userMap[msg.clientId].name;
		}
		const senderUserNameIsUnique = realUserName ?
			(newRd.userList || []).filter(user => getRoomUserName(user) === realUserName).length === 1 :
			false;

		// Part 1: Update message history and send notifications (for 'file_start' type)
		if (msgType === 'file_start' || msgType === 'file_start_private') {
			const historyMsgType = msgType === 'file_start_private' ? 'file_private' : 'file';
			
			const fileId = msg.data && msg.data.fileId;
			if (fileId) { // Only proceed if we have a fileId
				const messageAlreadyInHistory = newRd.messages.some(
					m => m.msgType === historyMsgType && m.text && m.text.fileId === fileId && m.userName === realUserName
				);

				if (!messageAlreadyInHistory) {
					appendMessage(newRd.messages, {
						type: 'other',
						text: msg.data, // This is the file metadata object
						userName: realUserName,
						avatar: realUserName,
						msgType: historyMsgType,
						timestamp: (msg.data && msg.data.timestamp) || Date.now() 
					});
				}
			}

			const notificationMsgType = msgType.includes('_private') ? 'private file' : 'file';
			if (window.notifyMessage && msg.data && msg.data.fileName) {
				window.notifyMessage(newRd.roomName, notificationMsgType, `${msg.data.fileName}`, realUserName);
			}
		}

		const isActiveRoom = activeRoomIndex === idx;
		if (window.handleFileMessage) {
			window.handleFileMessage(msg.data, msgType.includes('_private'), {
				renderMessage: isActiveRoom,
				roomIndex: idx,
				senderClientId: msg.clientId,
				senderUserName: realUserName,
				senderUserNameIsUnique,
				isConnectionOpen: () => Boolean(newRd.chat && typeof newRd.chat.isOpen === 'function' && newRd.chat.isOpen()),
				sendClientMessage: (targetClientId, type, data) => {
					if (!newRd.chat || typeof newRd.chat.sendClientMessage !== 'function') {
						return false
					}
					return newRd.chat.sendClientMessage(targetClientId, type, data)
				}
			});
		}

		// Part 2: Handle UI interaction (rendering in active room, or unread count in inactive room)
		if (!isActiveRoom) {
			// If it's not the active room, only increment unread count for 'file_start' messages.
			if (msgType === 'file_start' || msgType === 'file_start_private') {
				newRd.unreadCount = (newRd.unreadCount || 0) + 1;
				renderRooms(activeRoomIndex);
			}
		}
		return; // File messages are fully handled.
	}

	// Handle image messages (both new and legacy formats)
	if (msgType === 'image' || msgType === 'image_private') {
		// Already has correct type
	} else if (!msgType.includes('_private')) {
		// Handle legacy image detection
		if (msg.data && typeof msg.data === 'string' && msg.data.startsWith('data:image/')) {
			msgType = 'image';
		} else if (msg.data && typeof msg.data === 'object' && msg.data.image) {
			msgType = 'image';
		}
	}
	let realUserName = msg.userName;
	if (!realUserName && msg.clientId && newRd.userMap[msg.clientId]) {
		realUserName = newRd.userMap[msg.clientId].userName || newRd.userMap[msg.clientId].username || newRd.userMap[msg.clientId].name;
	}

	// Add message to messages array for chat history
	appendMessage(roomsData[idx].messages, {
		type: 'other',
		text: msg.data,
		userName: realUserName,
		avatar: realUserName,
		msgType: msgType,
		timestamp: Date.now()
	});

	// Only add message to chat display if it's for the active room
	if (activeRoomIndex === idx) {
		if (window.addOtherMsg) {
			window.addOtherMsg(msg.data, realUserName, realUserName, false, msgType);
		}
	} else {
		roomsData[idx].unreadCount = (roomsData[idx].unreadCount || 0) + 1;
		renderRooms(activeRoomIndex);
	}

	const notificationMsgType = msgType.includes('_private') ? `private ${msgType.split('_')[0]}` : msgType;
	if (window.notifyMessage) {
		window.notifyMessage(newRd.roomName, notificationMsgType, msg.data, realUserName);
	}
}

// Toggle private chat with a user
// 切换与某用户的私聊
export function togglePrivateChat(targetId, targetName) {
	const rd = roomsData[activeRoomIndex];
	if (!rd) return;
	if (rd.privateChatTargetId === targetId) {
		rd.privateChatTargetId = null;
		rd.privateChatTargetName = null
	} else {
		rd.privateChatTargetId = targetId;
		rd.privateChatTargetName = targetName
	}
	renderUserList();
	updateChatInputStyle()
}


// Exit the current room
// 退出当前房间
export function exitRoom() {
	if (activeRoomIndex >= 0 && roomsData[activeRoomIndex]) {
		const chatInst = roomsData[activeRoomIndex].chat;
		if (chatInst && typeof chatInst.destruct === 'function') {
			chatInst.destruct()
		} else if (chatInst && typeof chatInst.disconnect === 'function') {
			chatInst.disconnect()
		}
		roomsData[activeRoomIndex].chat = null;
		roomsData.splice(activeRoomIndex, 1);
		if (roomsData.length > 0) {
			switchRoom(0);
			return true
		} else {
			return false
		}
	}
	return false
}

export { roomsData, activeRoomIndex };

// Listen for sidebar username update event
// 监听侧边栏用户名更新事件
window.addEventListener('updateSidebarUsername', () => {
	if (activeRoomIndex >= 0 && roomsData[activeRoomIndex]) {
		const rd = roomsData[activeRoomIndex];
		const sidebarUsername = document.getElementById('sidebar-username');
		if (sidebarUsername && rd.myUserName) {
			sidebarUsername.textContent = rd.myUserName;
		}
		// Also update the avatar to ensure consistency
		if (rd.myUserName) {
			setSidebarAvatar(rd.myUserName);
		}
	}
});

window.addEventListener('nodecrypt:clear-private-chat', () => {
	const rd = roomsData[activeRoomIndex];
	if (!rd || !rd.privateChatTargetId) return;
	rd.privateChatTargetId = null;
	rd.privateChatTargetName = null;
	renderUserList();
	updateChatInputStyle()
});
