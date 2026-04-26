(function(){
"use strict";

// ---------- 全局变量 ----------
// 所有全局变量已在 config.js 中声明，此处不再重复声明

// DOM元素初始化（变量已在config.js中声明）
advancedBtn = document.getElementById('advancedBtn');
advancedPanel = document.getElementById('advancedPanel');
serverUrlInput = document.getElementById('serverUrl');
applyServerBtn = document.getElementById('applyServerBtn');
stunServerInput = document.getElementById('stunServer');
applyStunBtn = document.getElementById('applyStunBtn');
roomIdInput = document.getElementById('roomIdInput');
applyRoomIdBtn = document.getElementById('applyRoomIdBtn');
if (!roomIdInput) console.error('roomIdInput not found');
burstRangeInput = document.getElementById('burstRangeInput');
applyBurstRangeBtn = document.getElementById('applyBurstRangeBtn');
regexPatternContainer = document.getElementById('regexPatternList');
addRegexPatternBtn = document.getElementById('addRegexPatternBtn');
logBox = document.getElementById('logBox');
var centerDisplay = document.getElementById('centerDisplay');
myIdDisplay = document.getElementById('myIdDisplay');
peersGroup = document.getElementById('peersGroup');
radarStatus = document.getElementById('radarStatus');
scanSection = document.getElementById('scanSection');
qrcodeDiv = document.getElementById('qrcode');
sidebarItems = document.getElementById('sidebarItems');
modalOverlay = document.getElementById('modalOverlay');
modalTitle = document.getElementById('modalTitle');
modalMessage = document.getElementById('modalMessage');
modalCancelBtn = document.getElementById('modalCancelBtn');
modalConfirmBtn = document.getElementById('modalConfirmBtn');

// modalResolve 已在 config.js 中声明

// 从config.js初始化高级设置输入框
serverUrlInput.value = serverUrl;
stunServerInput.value = stunServer;
burstRangeInput.value = gatewayBurstRange;

// ====== 多连接管理 ======

function createConnectionEntry(peerId, roleType) {
    if (connections[peerId]) {
        if (connections[peerId].pc) connections[peerId].pc.close();
        delete connections[peerId];
    }
    var entry = { pc: null, dc: null, role: roleType, targetId: peerId, connected: false, messages: [] };
    connections[peerId] = entry;
    return entry;
}

function getActiveConnection() {
    if (activePeerId && connections[activePeerId]) return connections[activePeerId];
    return null;
}

function syncGlobalsToActive() {
    var conn = getActiveConnection();
    if (conn) {
        pc = conn.pc;
        dc = conn.dc;
        targetId = conn.targetId;
        role = conn.role;
    } else {
        pc = null;
        dc = null;
        targetId = null;
        role = null;
    }
}

function switchToHome() {
    // 隐藏所有对等聊天界面
    var tabs = document.getElementById('peerTabs');
    if (tabs) {
        var activeTabs = tabs.querySelectorAll('.peer-chat-container.active');
        for (var i = 0; i < activeTabs.length; i++) activeTabs[i].classList.remove('active');
    }
    // 显示雷达视图
    var viewRadar = document.getElementById('view-radar');
    if (viewRadar) viewRadar.classList.add('active-view');

    // 更新侧边栏激活状态
    var items = document.querySelectorAll('#sidebarItems .nav-item');
    for (var i = 0; i < items.length; i++) items[i].classList.remove('active-nav');
    var homeItem = document.getElementById('homeSidebarItem');
    if (homeItem) homeItem.classList.add('active-nav');

    activePeerId = null;
    pc = null; dc = null; targetId = null; role = null;

    addLog('[导航] 切换到首页');
    // 重新连接信令
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        startRadarMode().catch(function(e) {
            addLog('[错误] 首页重连失败: ' + e);
        });
    }
}

function switchToPeer(peerId) {
    var conn = connections[peerId];
    if (!conn) { addLog('[错误] 切换失败: 连接 ' + peerId + ' 不存在'); return; }

    // 隐藏雷达视图
    var viewRadar = document.getElementById('view-radar');
    if (viewRadar) viewRadar.classList.remove('active-view');

    // 隐藏所有选项卡，显示目标选项卡
    var tabs = document.getElementById('peerTabs');
    var allContainers = tabs.querySelectorAll('.peer-chat-container');
    for (var i = 0; i < allContainers.length; i++) allContainers[i].classList.remove('active');
    var targetContainer = tabs.querySelector('.peer-chat-container[data-peerid="' + peerId + '"]');
    if (targetContainer) targetContainer.classList.add('active');

    // 更新侧边栏激活状态
    var items = document.querySelectorAll('#sidebarItems .nav-item');
    for (var i = 0; i < items.length; i++) items[i].classList.remove('active-nav');
    var sideItem = document.querySelector('#sidebarItems .nav-item[data-peerid="' + peerId + '"]');
    if (sideItem) sideItem.classList.add('active-nav');

    activePeerId = peerId;
    syncGlobalsToActive();
    addLog('[导航] 切换到 ' + peerId);
}

function cleanupConnection(peerId) {
    var conn = connections[peerId];
    if (!conn) return;

    // 通过数据通道通知对方断开（同步断开）
    if (conn.dc && conn.dc.readyState === 'open') {
        try {
            conn.dc.send(JSON.stringify({ type: 'disconnect' }));
            addLog('[同步断开] 已通知 ' + peerId + ' 断开连接');
        } catch(e) {
            addLog('[同步断开] 通知失败: ' + e);
        }
    }

    if (conn.pc) {
        try { conn.pc.close(); } catch(e) {}
    }
    // 移除侧边栏
    removePeerSidebarItem(peerId);
    // 移除聊天界面
    var container = document.querySelector('#peerTabs .peer-chat-container[data-peerid="' + peerId + '"]');
    if (container) {
        container.classList.remove('active');
        container.remove();
    }
    // 从连接池移除
    delete connections[peerId];
    addLog('[连接] 已清理 ' + peerId + ' 的连接');

    // 如果当前显示的是这个对等端，切到最近的其他对等端或首页
    if (activePeerId === peerId) {
        var remainingPeers = [];
        for (var k in connections) {
            if (connections.hasOwnProperty(k)) remainingPeers.push(k);
        }
        if (remainingPeers.length > 0) {
            switchToPeer(remainingPeers[remainingPeers.length - 1]);
        } else {
            switchToHome();
        }
    }

    // 更新分隔符和空状态
    updatePeerSeparator();
}

// ====== 侧边栏管理 ======

var sidebarOpen = false;

function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    var sidebar = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebarOverlay');
    if (sidebar) sidebar.classList.toggle('open', sidebarOpen);
    if (overlay) overlay.classList.toggle('active', sidebarOpen);
}

function openSidebar() {
    if (!sidebarOpen) toggleSidebar();
}

function closeSidebar() {
    if (sidebarOpen) toggleSidebar();
}

function updatePeerSeparator() {
    var separator = document.getElementById('peerSeparator');
    if (!separator) return;
    var count = 0;
    for (var k in connections) { if (connections.hasOwnProperty(k)) count++; }
    separator.style.display = count > 0 ? 'block' : 'none';

    var emptyEl = document.getElementById('sidebarEmpty');
    if (emptyEl) emptyEl.style.display = count === 0 ? 'block' : 'none';
}

function addPeerSidebarItem(peerId) {
    var itemsContainer = document.getElementById('sidebarItems');
    if (!itemsContainer) return;
    // 检查是否已存在
    var existing = itemsContainer.querySelector('.nav-item[data-peerid="' + peerId + '"]');
    if (existing) return;

    var item = document.createElement('div');
    item.className = 'nav-item';
    item.setAttribute('data-peerid', peerId);
    item.innerHTML = '<span class="nav-item-icon">🟢</span>' +
        '<span class="nav-item-name">' + escHtml(peerId) + '</span>' +
        '<button class="nav-item-close" title="关闭连接">✕</button>';

    // 点击切换到对等端
    item.onclick = function(e) {
        if (e.target.classList.contains('nav-item-close')) return;
        if (activePeerId === peerId) return;
        openSidebar();
        switchToPeer(peerId);
    };

    // 关闭按钮
    var closeBtn = item.querySelector('.nav-item-close');
    closeBtn.onclick = function(e) {
        e.stopPropagation();
        cleanupConnection(peerId);
    };

    itemsContainer.appendChild(item);

    // 更新分隔符
    updatePeerSeparator();
}

function removePeerSidebarItem(peerId) {
    var item = document.querySelector('#sidebarItems .nav-item[data-peerid="' + peerId + '"]');
    if (item) item.remove();
    updatePeerSeparator();
}

// ====== 创建对等聊天界面 (test3.html 风格) ======

function createPeerChatContainer(peerId) {
    var template = document.getElementById('transferTemplate');
    if (!template) return null;
    var tabs = document.getElementById('peerTabs');
    if (!tabs) return null;

    // 检查是否已存在
    var existing = tabs.querySelector('.peer-chat-container[data-peerid="' + peerId + '"]');
    if (existing) return existing;

    // 克隆模板
    var container = template.querySelector('.peer-chat-container').cloneNode(true);
    container.setAttribute('data-peerid', peerId);
    container.querySelector('.transfer-peer-id').textContent = peerId;

    // 绑定汉堡按钮
    var menuToggle = container.querySelector('.chat-menu-toggle');
    menuToggle.onclick = function() { toggleSidebar(); };

    // 绑定消息发送
    var msgInput = container.querySelector('.message-input');
    var sendBtn = container.querySelector('.send-msg-btn');
    var fileInput = container.querySelector('.file-input');
    var fileLabel = container.querySelector('.file-label-btn');

    sendBtn.onclick = function() {
        var text = msgInput.value.trim();
        if (!text) return;
        var conn = connections[peerId];
        if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
            addLog('[发送失败] 数据通道未就绪');
            return;
        }
        conn.dc.send(JSON.stringify({ type: 'chat', text: text }));
        addPeerMessage(peerId, 'self', text);
        msgInput.value = '';
    };
    msgInput.onkeypress = function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendBtn.onclick();
        }
    };

    fileLabel.onclick = function() { fileInput.click(); };
    fileInput.onchange = function() {
        if (fileInput.files.length) {
            var conn = connections[peerId];
            if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
                addLog('[发送失败] 数据通道未就绪');
                fileInput.value = '';
                return;
            }
            sendFileOverDC(conn.dc, fileInput.files[0], peerId);
            fileInput.value = '';
        }
    };

    tabs.appendChild(container);

    // 恢复已有的消息历史
    if (connections[peerId] && connections[peerId].messages) {
        var existingMsgs = connections[peerId].messages;
        connections[peerId].messages = [];
        for (var i = 0; i < existingMsgs.length; i++) {
            addPeerMessage(peerId, existingMsgs[i].sender, existingMsgs[i].text);
        }
    }

    return container;
}

function addPeerMessage(peerId, sender, text) {
    var container = document.querySelector('#peerTabs .peer-chat-container[data-peerid="' + peerId + '"]');
    if (!container) return;
    var msgList = container.querySelector('.transfer-messages');
    if (!msgList) return;

    var wrapper = document.createElement('div');
    if (sender === 'self') {
        wrapper.className = 'message-wrapper self-msg';
    } else if (sender === 'system') {
        wrapper.className = 'message-wrapper system-msg';
    } else {
        wrapper.className = 'message-wrapper peer-msg';
    }

    var bubble = document.createElement('div');
    bubble.className = 'message';
    bubble.textContent = text;
    wrapper.appendChild(bubble);
    msgList.appendChild(wrapper);

    // 滚动到底部
    var chatContainer = container.querySelector('.chat-container');
    if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;

    // 也存到连接的消息历史
    if (connections[peerId]) {
        connections[peerId].messages.push({ sender: sender, text: text });
    }
}

function setupDataChannelForPeer(peerId, channel) {
    channel.binaryType = 'arraybuffer';
    var fileBuffers = [];
    var fileName = '';
    var fileSize = 0;

    channel.onopen = function() {
        addLog('[数据通道] ' + peerId + ' 已打开');
        addPeerMessage(peerId, 'system', '数据通道已建立');
    };
    channel.onclose = function() {
        addLog('[数据通道] ' + peerId + ' 关闭');
    };
    channel.onmessage = function(e) {
        if (typeof e.data === 'string') {
            try {
                var msg = JSON.parse(e.data);
                if (msg.type === 'file-meta') {
                    fileName = msg.name;
                    fileSize = msg.size;
                    fileBuffers = [];
                    addPeerMessage(peerId, 'system', '准备接收: ' + msg.name);
                } else if (msg.type === 'file-end') {
                    var blob = new Blob(fileBuffers);
                    var a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = fileName;
                    a.click();
                    URL.revokeObjectURL(a.href);
                    addPeerMessage(peerId, 'system', '接收完成');
                } else if (msg.type === 'chat') {
                    addPeerMessage(peerId, 'peer', msg.text);
                } else if (msg.type === 'disconnect') {
                    // 对方主动断开连接，同步清理
                    addLog('[同步断开] ' + peerId + ' 已断开连接');
                    addPeerMessage(peerId, 'system', '对方已断开连接');
                    // 延迟清理，让用户看到消息
                    setTimeout(function() {
                        cleanupConnection(peerId);
                    }, 100);
                }
            } catch(ex) {}
        } else if (e.data instanceof ArrayBuffer) {
            fileBuffers.push(e.data);
        }
    };
}

// 通过数据通道发送文件
function sendFileOverDC(dcChannel, file, peerId) {
    dcChannel.send(JSON.stringify({ type: 'file-meta', name: file.name, size: file.size }));
    var chunkSize = 16 * 1024;
    var offset = 0;
    var reader = new FileReader();
    reader.onload = function(e) {
        dcChannel.send(e.target.result);
        offset += e.target.result.byteLength;
        if (offset < file.size) readNext();
        else {
            dcChannel.send(JSON.stringify({ type: 'file-end' }));
            addPeerMessage(peerId, 'system', '发送完成: ' + file.name);
        }
    };
    var readNext = function() { reader.readAsArrayBuffer(file.slice(offset, offset + chunkSize)); };
    readNext();
}

// 兼容旧版：全局sendChatMessage和sendFile（无参数版本使用activePeerId）
function sendChatMessage() {
    if (activePeerId) {
        var container = document.querySelector('#peerTabs .peer-chat-container[data-peerid="' + activePeerId + '"]');
        if (container) {
            var sendBtn = container.querySelector('.send-msg-btn');
            if (sendBtn) sendBtn.onclick();
        }
    }
}
function sendFile(file) {
    if (activePeerId) {
        var conn = connections[activePeerId];
        if (conn && conn.dc) {
            sendFileOverDC(conn.dc, file, activePeerId);
        }
    }
}

// ====== 侧边栏事件绑定 ======

document.getElementById('sidebarToggle').onclick = function() {
    toggleSidebar();
};

document.getElementById('sidebarOverlay').onclick = function() {
    closeSidebar();
};

// 首页按钮
document.getElementById('homeSidebarItem').onclick = function() {
    closeSidebar();
    switchToHome();
};

function showModal(title, message) {
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modalOverlay.classList.remove('hidden');
    return new Promise((resolve) => {
        modalResolve = resolve;
    });
}
function hideModal(result) {
    modalOverlay.classList.add('hidden');
    if (modalResolve) {
        modalResolve(result);
        modalResolve = null;
    }
}

modalConfirmBtn.onclick = () => hideModal(true);
modalCancelBtn.onclick = () => hideModal(false);

function addLog(msg) {
    if (logBox) {
        logBox.textContent += msg + '\n';
        logBox.scrollTop = logBox.scrollHeight;
    } else {
        console.log('LOG:', msg);
    }
}
function clearLog() { logBox.textContent = ''; }

// ---------- 信令连接 ----------
function connectSignaling() {
    if (!serverUrl) {
        addLog('[错误] 未设置服务器地址');
        return Promise.reject('no server');
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
    }
    return new Promise((resolve, reject) => {
        ws = new WebSocket(`wss://${serverUrl}`);
        ws.onopen = () => {
            serverConnected = true;
            addLog('[信令] 连接成功');
            resolve();
        };
        ws.onmessage = (e) => handleSignalingMessage(JSON.parse(e.data));
        ws.onclose = () => {
            serverConnected = false;
            addLog('[信令] 断开');
        };
        ws.onerror = (err) => {
            addLog('[信令] 连接错误');
            reject(err);
        };
    });
}

function handleSignalingMessage(msg) {
    addLog(`[信令收] ${msg.type} ${msg.from ? 'from '+msg.from : ''}`);
    if (msg.type === 'ok') {
        myId = msg.id;
        if (myIdDisplay) myIdDisplay.textContent = myId;
        addLog(`[信令] 我的ID: ${myId}`);
        ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId } }));
    } else if (msg.type === 'same_network_clients') {
        peerNodes = msg.clients;
        updateRadarPeers();
        radarStatus.textContent = `发现 ${peerNodes.length} 个设备`;
    } else if (msg.type === 'new_peer') {
        if (!peerNodes.includes(msg.peer_id)) {
            peerNodes.push(msg.peer_id);
            updateRadarPeers();
        }
    } else if (msg.type === 'peer_left') {
        peerNodes = peerNodes.filter(id => id !== msg.peer_id);
        updateRadarPeers();
    } else if (msg.type === 'connect_request') {
        handleConnectRequest(msg.from);
    } else if (msg.type === 'connect_accept') {
        startWebRTCAsInitiator(msg.from);
    } else if (msg.type === 'answer') {
        if (role === 'receiver') {
            if (msg.from && !connections[msg.from]) {
                targetId = msg.from;
                createConnectionEntry(msg.from, role);
                connections[msg.from].pc = pc;
                connections[msg.from].dc = dc;
            }
            handleRemoteAnswerCompressed(msg.payload);
        }
    } else if (msg.type === 'offer') {
        handleRemoteOfferCompressed(msg.payload, msg.from);
    } else if (msg.type === 'ice') {
        handleRemoteIce(msg.payload);
    }
}

async function handleConnectRequest(fromId) {
    gatewayBurstAttempted = false;
    carrierNatHandlingStage = 0;
    carrierNatDetectedIp = null;
    carrierNatRealTimeDetectionTriggered = false;
    carrierNatReplacementMap = {};

    pendingIceCandidates = [];
    remoteIceCandidates = [];
    localCandidates = [];

    createConnectionEntry(fromId, 'sender');
    targetId = fromId;
    role = 'sender';

    ws.send(JSON.stringify({ type: 'connect_accept', target: fromId }));
    addLog(`[连接] 自动接受 ${fromId} 的连接请求`);
}

async function startWebRTCAsInitiator(peerId) {
    createConnectionEntry(peerId, 'receiver');
    targetId = peerId;
    role = 'receiver';
    radarStatus.textContent = `连接 ${peerId}...`;
    createPeerConnection();
    if (connections[peerId]) connections[peerId].pc = pc;
    createDataChannel();
    if (connections[peerId]) connections[peerId].dc = dc;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise(resolve => {
        const check = () => {
            if (pc.iceGatheringState === 'complete') resolve();
            else setTimeout(check, 100);
        };
        check();
    });
    const sdp = pc.localDescription.sdp;
    const u = sdp.match(/a=ice-ufrag:(.+)/)[1];
    const p = sdp.match(/a=ice-pwd:(.+)/)[1];
    const f = sdp.match(/a=fingerprint:sha-256 (.+)/)[1];
    const iceCompact = localCandidates.map(c => {
        const parts = c.candidate.split(' ');
        const typIdx = parts.indexOf('typ');
        return { ip: parts[typIdx-2], port: parseInt(parts[typIdx-1]), type: parts[typIdx+1] };
    });
    ws.send(JSON.stringify({
        type: 'offer',
        target: peerId,
        payload: { u, p, f, ice: iceCompact }
    }));
    addLog(`[探查] 发送Offer给 ${peerId}`);
}

// ---------- WebRTC 核心 ----------
function buildSDP(type, ufrag, pwd, fingerprint) {
    const sessionId = Math.floor(Math.random() * 1e18);
    return `v=0\r
o=- ${sessionId} 2 IN IP4 127.0.0.1\r
s=-\r
t=0 0\r
a=group:BUNDLE 0\r
a=extmap-allow-mixed\r
a=msid-semantic: WMS\r
m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r
c=IN IP4 0.0.0.0\r
a=ice-ufrag:${ufrag}\r
a=ice-pwd:${pwd}\r
a=ice-options:trickle\r
a=fingerprint:sha-256 ${fingerprint}\r
a=setup:${type === 'offer' ? 'actpass' : 'active'}\r
a=mid:0\r
a=sctp-port:5000\r
a=max-message-size:262144\r
`;
}

function buildICECandidate(ip, port, type, ufrag) {
    const foundation = Math.floor(Math.random() * 2e9);
    const priority = (type === 'host') ? (ip.includes(':') ? 2113939711 : 2113937151) : 0;
    return `candidate:${foundation} 1 udp ${priority} ${ip} ${port} typ ${type} generation 0 ufrag ${ufrag} network-cost 999`;
}

function createPeerConnection() {
    if (pc) {
        pc.close();
        pc = null;
    }
    pendingIceCandidates = [];
    remoteIceCandidates = [];
    const iceServers = stunServer ? [{ urls: stunServer }] : [];
    pc = new RTCPeerConnection({ iceServers });

    // 捕获创建时的目标ID，避免切换tab后targetId变化
    var createdPcForPeerId = targetId;

    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        addLog(`[连接状态] ${state}`);
        var connStateR = document.getElementById('connStateR');
        if (connStateR) connStateR.textContent = state;

        if (state === 'connected') {
            connectionFailureCount = 0;
            var peerId = createdPcForPeerId || targetId;
            if (peerId && connections[peerId]) {
                connections[peerId].pc = pc;
                connections[peerId].connected = true;

                // 确保DC已保存到连接条目（可能由ondatachannel或createDataChannel设置）
                if (!connections[peerId].dc && dc) {
                    connections[peerId].dc = dc;
                }

                // 创建聊天UI
                createPeerChatContainer(peerId);

                // 设置数据通道（使用per-peer版本）
                var peerDc = connections[peerId].dc || dc;
                if (peerDc) {
                    setupDataChannelForPeer(peerId, peerDc);
                }

                // 添加到侧边栏
                addPeerSidebarItem(peerId);
                // 切换到对等端界面
                switchToPeer(peerId);
                // 自动打开侧边栏
                openSidebar();
                // 连接成功，断开信令
                if (ws) {
                    addLog('[信令] 连接已建立，断开信令服务器');
                    ws.close();
                }
            }
        } else if (state === 'failed') {
            connectionFailureCount++;
            addLog(`[连接失败] 失败次数: ${connectionFailureCount}`);

            var cleanupId = createdPcForPeerId || targetId;
            if (cleanupId) {
                // 延迟清理，让用户看到状态
                setTimeout(function() {
                    if (connections[cleanupId] && !connections[cleanupId].connected) {
                        cleanupConnection(cleanupId);
                    }
                }, 500);
            }
        } else if (state === 'disconnected') {
            // ICE断开，尝试ICE重启，不立即清理
            addLog('[连接断开] 等待可能的重连...');
            // 如果5秒内没有恢复，清理连接
            var discPeerId = createdPcForPeerId || targetId;
            if (discPeerId) {
                setTimeout(function() {
                    if (connections[discPeerId] && connections[discPeerId].pc) {
                        var currentState = connections[discPeerId].pc.connectionState;
                        if (currentState === 'disconnected' || currentState === 'failed') {
                            addLog('[连接清理] 超时未恢复，清理 ' + discPeerId);
                            cleanupConnection(discPeerId);
                        }
                    }
                }, 5000);
            }
        }
    };

    pc.onicecandidate = (e) => {
        if (e.candidate) {
            localCandidates.push(e.candidate);
            addLog(`[本地ICE] ${e.candidate.candidate}`);
            if (ws && ws.readyState === WebSocket.OPEN && targetId) {
                ws.send(JSON.stringify({
                    type: 'ice',
                    target: targetId,
                    payload: e.candidate.candidate
                }));
            }
        } else {
            addLog('[ICE收集] 完成');
            if (role === 'receiver' && centerDisplay && centerDisplay.classList.contains('show-qr')) {
                generateCompressedQR();
            }
        }
    };

    pc.ondatachannel = (e) => {
        dc = e.channel;
        var peerId = createdPcForPeerId || targetId;
        if (peerId && connections[peerId]) {
            connections[peerId].dc = dc;
            // 直接使用per-peer版本，不再调用旧版setupDataChannel
            setupDataChannelForPeer(peerId, dc);
        }
    };

    return pc;
}

async function generateOffer() {
    try {
        if (pc) {
            addLog('[Offer] 关闭旧连接');
            pc.close();
        }
        localCandidates = [];

        addLog('[Offer] 初始化 PeerConnection...');
        createPeerConnection();

        addLog('[Offer] 创建 DataChannel...');
        createDataChannel();

        addLog('[Offer] 正在创建 SDP Offer...');
        const offer = await pc.createOffer();

        addLog('[Offer] 设置本地描述...');
        await pc.setLocalDescription(offer);

        addLog('[Offer] 等待 ICE 收集...');
    } catch (err) {
        addLog('[错误] generateOffer 内部崩溃: ' + err.message);
        throw err;
    }
}

async function handleRemoteAnswerCompressed(compressed) {
    const { u, p, f } = compressed;
    const answerSdp = buildSDP('answer', u, p, f);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    addLog('[设置远程Answer] 成功');
    while (pendingIceCandidates.length) {
        const cand = pendingIceCandidates.shift();
        await pc.addIceCandidate({ candidate: cand, sdpMid: '0', sdpMLineIndex: 0 }).catch(e=>addLog('[缓存ICE添加失败] '+e));
    }
}

async function handleRemoteOfferCompressed(compressed, fromId) {
    addLog(`[探查] 处理来自 ${fromId} 的offer`);
    targetId = fromId;
    role = 'sender';
    const { u, p, f, ice } = compressed;
    const offerSdp = buildSDP('offer', u, p, f);

    var savedPendingIce = pendingIceCandidates.slice();
    var savedRemoteIce = remoteIceCandidates.slice();

    createPeerConnection();
    if (connections[fromId]) connections[fromId].pc = pc;
    remoteIceCandidates = savedRemoteIce;
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    for (const ic of ice) {
        await pc.addIceCandidate({ candidate: buildICECandidate(ic.ip, ic.port, ic.type, u), sdpMid: '0', sdpMLineIndex: 0 });
    }

    for (var i = 0; i < savedPendingIce.length; i++) {
        await pc.addIceCandidate({ candidate: savedPendingIce[i], sdpMid: '0', sdpMLineIndex: 0 }).catch(e=>addLog('[缓存ICE添加失败] '+e));
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const ansSdp = answer.sdp;
    const ansU = ansSdp.match(/a=ice-ufrag:(.+)/)[1];
    const ansP = ansSdp.match(/a=ice-pwd:(.+)/)[1];
    const ansF = ansSdp.match(/a=fingerprint:sha-256 (.+)/)[1];
    await new Promise(r => setTimeout(r, 500));
    const answerCompressed = { u: ansU, p: ansP, f: ansF };
    ws.send(JSON.stringify({ type: 'answer', target: targetId, payload: answerCompressed }));
    addLog(`[探查] 发送Answer给 ${targetId}`);
}

async function reconnectWithCarrierNatReplacement(detectedCarrierNatIp, replacementIpOrIps, port) {
    addLog(`[运营商NAT重新连接] 开始重新连接，替换IP: ${detectedCarrierNatIp}`);

    if (Array.isArray(replacementIpOrIps)) {
        carrierNatReplacementMap[detectedCarrierNatIp] = replacementIpOrIps;
    } else {
        carrierNatReplacementMap[detectedCarrierNatIp] = replacementIpOrIps;
    }

    gatewayBurstAttempted = true;

    if (pc) {
        pc.close();
        pc = null;
    }

    connectionFailureCount = 0;
    remoteIceCandidates = [];
    pendingIceCandidates = [];
    localCandidates = [];
    carrierNatRealTimeDetectionTriggered = false;

    if (role === 'receiver' && targetId) {
        addLog(`[运营商NAT重新连接] 主动方重新连接 ${targetId}`);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'connect_request', target: targetId }));
            radarStatus.textContent = `运营商NAT检测，重新连接 ${targetId}...`;
        }
    } else if (role === 'sender' && targetId) {
        addLog(`[运营商NAT重新连接] 被动方发送连接请求给 ${targetId}`);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'connect_request', target: targetId }));
            radarStatus.textContent = `运营商NAT检测，发送连接请求给 ${targetId}...`;
        }
    } else {
        addLog(`[运营商NAT重新连接] 无法重新连接：role=${role}, targetId=${targetId}`);
    }
}

function replaceIceCandidateIp(candidateStr) {
    if (!candidateStr || typeof candidateStr !== 'string') return candidateStr;

    const parts = candidateStr.split(' ');
    if (parts.length < 8) return candidateStr;

    const originalIp = parts[4];
    if (!originalIp || originalIp.includes(':')) return candidateStr;

    const replacement = carrierNatReplacementMap[originalIp];
    if (!replacement) return candidateStr;

    const replacementIp = Array.isArray(replacement) ? replacement[0] : replacement;
    parts[4] = replacementIp;
    return parts.join(' ');
}

function extractLocalUfrag() {
    if (!pc || !pc.localDescription || !pc.localDescription.sdp) return '';
    var match = pc.localDescription.sdp.match(/a=ice-ufrag:(.+)/);
    return match ? match[1].trim() : '';
}

async function handleRemoteIce(candidateStr) {
    var parts = candidateStr.split(' ');
    var originalIp = parts.length >= 8 ? parts[4] : null;
    var candidatePort = parts.length >= 8 ? parseInt(parts[5], 10) : NaN;

    if (carrierNatDetectionEnabled && !gatewayBurstAttempted && !carrierNatRealTimeDetectionTriggered) {
        if (originalIp && window.isCarrierNatIp && window.isCarrierNatIp(originalIp)) {
            if (!carrierNatDetectedIp) {
                carrierNatDetectedIp = originalIp;
            }
            if (!carrierNatReplacementMap[originalIp]) {
                if (window.setupRealtimeReplacement) {
                    var replacementIp = window.setupRealtimeReplacement(originalIp);
                    if (replacementIp) {
                        carrierNatRealTimeDetectionTriggered = true;
                        addLog('[运营商NAT] 实时替换: ' + originalIp + ' → ' + replacementIp);
                    }
                }
            }
        }
    }

    var replacedCandidate = replaceIceCandidateIp(candidateStr);
    var replacedIp = replacedCandidate.split(' ')[4];

    if (originalIp !== replacedIp) {
        addLog('[ICE替换] ' + originalIp + ' -> ' + replacedIp);
    }

    remoteIceCandidates.push(candidateStr);

    if (!pc) {
        pendingIceCandidates.push(replacedCandidate);
        addLog('[ICE缓存] 无PeerConnection，等待offer');
        return;
    }

    if (pc.remoteDescription && pc.remoteDescription.type) {
        try {
            await pc.addIceCandidate({ candidate: replacedCandidate, sdpMid: '0', sdpMLineIndex: 0 });
            addLog('[添加远程ICE] 成功' + (originalIp !== replacedIp ? '（已替换IP）' : ''));
        } catch (e) {
            addLog('[添加远程ICE失败] ' + e);
        }
    } else {
        pendingIceCandidates.push(replacedCandidate);
        addLog('[ICE缓存] 等待远程描述' + (originalIp !== replacedIp ? '（已替换IP）' : ''));
    }
}

// ---------- UI 绑定 ----------
advancedBtn.onclick = (e) => {
    e.stopPropagation();
    advancedPanel.classList.toggle('show');
};
// 点击高级面板外部区域关闭面板
document.addEventListener('click', function(e) {
    if (advancedPanel.classList.contains('show') &&
        !advancedPanel.contains(e.target) &&
        e.target !== advancedBtn &&
        !advancedBtn.contains(e.target)) {
        advancedPanel.classList.remove('show');
    }
});
applyServerBtn.onclick = () => {
    serverUrl = serverUrlInput.value.trim();
    addLog(`信令服务器: ${serverUrl}`);
};
applyStunBtn.onclick = () => {
    stunServer = stunServerInput.value.trim();
    addLog(`STUN服务器: ${stunServer}`);
};
roomIdInput.onchange = function() {
    const value = roomIdInput.value.trim();
    roomId = value;
    if (value) {
        addLog(`房间号已设置为: ${value}`);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId } }));
        }
    } else {
        addLog('已清除房间号，将按连接IP匹配');
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: '' } }));
        }
    }
};
roomIdInput.onkeypress = function(e) {
    if (e.key === 'Enter') roomIdInput.onchange();
};

applyBurstRangeBtn.onclick = () => {
    const value = burstRangeInput.value.trim();
    if (value) {
        gatewayBurstRange = value;
        addLog(`IP爆破范围已设置为: ${gatewayBurstRange}`);
    } else {
        addLog('[爆破范围] 输入无效');
    }
};

// ====== 新UI绑定 ======

var toggleDisplayBtn = document.getElementById('toggleDisplayBtn');
var scanBtn = document.getElementById('scanBtn');
var iconQr = document.getElementById('iconQr');
var iconRadar = document.getElementById('iconRadar');
var toggleLabel = document.getElementById('toggleLabel');
var isQrMode = false;

// 切换雷达/二维码显示
toggleDisplayBtn.onclick = async function() {
    if (isQrMode) {
        centerDisplay.classList.remove('show-qr');
        iconQr.style.display = 'block';
        iconRadar.style.display = 'none';
        toggleLabel.textContent = 'QR CODE';
        isQrMode = false;
        addLog('[显示] 切换到雷达模式');
    } else {
        centerDisplay.classList.add('show-qr');
        iconQr.style.display = 'none';
        iconRadar.style.display = 'block';
        toggleLabel.textContent = 'RADAR';
        isQrMode = true;
        role = 'receiver';
        addLog('[显示] 切换到二维码模式');

        try {
            if (!serverConnected) {
                addLog('[系统] 正在连接信令服务器...');
                await connectSignaling();
            }
            addLog('[系统] 正在生成 WebRTC Offer...');
            qrcodeDiv.innerHTML = '';
            await generateOffer();
            addLog('[系统] 二维码已就绪');
        } catch (e) {
            console.error('QR生成错误:', e);
            if (!serverConnected) {
                alert('连接信令服务器失败，请检查高级设置中的 URL');
            } else {
                alert('WebRTC 逻辑出错：' + (e.message || e || '未知错误'));
            }
        }
    }
};

// 扫码按钮
scanBtn.onclick = function() {
    scanSection.style.display = 'flex';
    startScan();
};

// 关闭扫码覆盖层
document.getElementById('cancelScanBtn').onclick = function() {
    scanSection.style.display = 'none';
    scanningActive = false;
    var video = document.getElementById('video');
    if (video && video.srcObject) video.srcObject.getTracks().forEach(function(t) { t.stop(); });
};

// ====== 运营商NAT连接失败处理 ======
async function attemptGatewayBurstOnFailure() {
    addLog('[运营商NAT] 连接失败，跳过NAT处理（不再提示用户）');
}

// ===== 正则检测模式UI管理 =====

function renderRegexPatternList() {
    if (!regexPatternContainer) return;
    var configs = window.getCarrierNatPatterns ? window.getCarrierNatPatterns() : [];
    var html = '';
    for (var i = 0; i < configs.length; i++) {
        html += '<div class="regex-item" data-index="' + i + '">' +
            '<div class="regex-item-header">' +
                '<input type="text" class="regex-name" value="' + escHtml(configs[i].name) + '" placeholder="名称（如 10.0.0.0/8）">' +
                '<button class="btn-remove-regex" onclick="removeRegexPattern(' + i + ')" title="删除此规则">✕</button>' +
            '</div>' +
            '<input type="text" class="regex-pattern" value="' + escHtml(configs[i].regex) + '" placeholder="正则表达式">' +
        '</div>';
    }
    regexPatternContainer.innerHTML = html;

    var nameInputs = regexPatternContainer.querySelectorAll('.regex-name');
    var patternInputs = regexPatternContainer.querySelectorAll('.regex-pattern');
    for (var j = 0; j < nameInputs.length; j++) {
        (function(idx) {
            nameInputs[idx].oninput = function() { applyRegexPatternChanges(); };
            patternInputs[idx].oninput = function() { applyRegexPatternChanges(); };
        })(j);
    }
}

function applyRegexPatternChanges() {
    if (!regexPatternContainer) return;
    var items = regexPatternContainer.querySelectorAll('.regex-item');
    var newConfigs = [];
    for (var i = 0; i < items.length; i++) {
        var nameInput = items[i].querySelector('.regex-name');
        var patternInput = items[i].querySelector('.regex-pattern');
        if (nameInput && patternInput && patternInput.value.trim()) {
            newConfigs.push({
                name: nameInput.value.trim() || '规则 ' + (i + 1),
                regex: patternInput.value.trim()
            });
        }
    }
    if (window.updateCarrierNatPatterns) {
        window.updateCarrierNatPatterns(newConfigs);
    }
    addLog('[NAT正则] 已更新检测规则，当前 ' + newConfigs.length + ' 条');
}

function addRegexPattern() {
    if (!regexPatternContainer) return;
    var configs = window.getCarrierNatPatterns ? window.getCarrierNatPatterns() : [];
    configs.push({ name: '新规则', regex: '^192\\.168\\.' });
    if (window.updateCarrierNatPatterns) {
        window.updateCarrierNatPatterns(configs);
    }
    renderRegexPatternList();
    addLog('[NAT正则] 已添加新规则，请编辑正则表达式');
}

function removeRegexPattern(index) {
    var configs = window.getCarrierNatPatterns ? window.getCarrierNatPatterns() : [];
    if (index >= 0 && index < configs.length) {
        var removed = configs.splice(index, 1)[0];
        if (window.updateCarrierNatPatterns) {
            window.updateCarrierNatPatterns(configs);
        }
        renderRegexPatternList();
        addLog('[NAT正则] 已删除规则: ' + removed.name);
    }
}

function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 将核心函数挂载到window对象
window.showModal = showModal;
window.hideModal = hideModal;
window.addLog = addLog;
window.clearLog = clearLog;
window.connectSignaling = connectSignaling;
window.handleSignalingMessage = handleSignalingMessage;
window.handleConnectRequest = handleConnectRequest;
window.startWebRTCAsInitiator = startWebRTCAsInitiator;
window.buildSDP = buildSDP;
window.buildICECandidate = buildICECandidate;
window.createPeerConnection = createPeerConnection;
window.generateOffer = generateOffer;
window.handleRemoteAnswerCompressed = handleRemoteAnswerCompressed;
window.handleRemoteOfferCompressed = handleRemoteOfferCompressed;
window.handleRemoteIce = handleRemoteIce;
window.extractLocalUfrag = extractLocalUfrag;
window.attemptGatewayBurstOnFailure = attemptGatewayBurstOnFailure;
window.reconnectWithCarrierNatReplacement = reconnectWithCarrierNatReplacement;
window.renderRegexPatternList = renderRegexPatternList;
window.applyRegexPatternChanges = applyRegexPatternChanges;
window.addRegexPattern = addRegexPattern;
window.removeRegexPattern = removeRegexPattern;
// 多连接管理导出
window.createConnectionEntry = createConnectionEntry;
window.switchToHome = switchToHome;
window.switchToPeer = switchToPeer;
window.cleanupConnection = cleanupConnection;
window.addPeerSidebarItem = addPeerSidebarItem;
window.removePeerSidebarItem = removePeerSidebarItem;
window.addPeerMessage = addPeerMessage;
window.toggleSidebar = toggleSidebar;
window.openSidebar = openSidebar;
window.closeSidebar = closeSidebar;
window.sendChatMessage = sendChatMessage;
window.sendFile = sendFile;
window.setupDataChannelForPeer = setupDataChannelForPeer;

// 初始化正则检测模式UI
if (addRegexPatternBtn) {
    addRegexPatternBtn.onclick = addRegexPattern;
}
setTimeout(function() {
    renderRegexPatternList();
    if (window.loadCarrierNatPatternsFromJson) {
        window.loadCarrierNatPatternsFromJson().then(function() {
            renderRegexPatternList();
        });
    }
}, 100);

clearLog();
addLog('🌐 系统就绪，自动启动雷达探测...');

// ====== 自动启动雷达探测 ======
setTimeout(async function() {
    try {
        addLog('[系统] 正在自动连接信令服务器...');
        await startRadarMode();
        addLog('[成功] 雷达模式已激活');
    } catch(e) {
        console.error('雷达自动启动失败:', e);
        addLog('[错误] 雷达启动失败: ' + (e.message || e));
        radarStatus.textContent = '连接失败';
    }
}, 200);
})();
