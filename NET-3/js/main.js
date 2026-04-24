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
if (!applyRoomIdBtn) console.error('applyRoomIdBtn not found');
if (!roomIdInput) console.error('roomIdInput not found');
burstRangeInput = document.getElementById('burstRangeInput');
applyBurstRangeBtn = document.getElementById('applyBurstRangeBtn');
regexPatternContainer = document.getElementById('regexPatternList');
addRegexPatternBtn = document.getElementById('addRegexPatternBtn');
logBox = document.getElementById('logBox');
qrQuickPanel = document.getElementById('qrQuickPanel');
genOfferSection = document.getElementById('genOfferSection');
scanSection = document.getElementById('scanSection');
radarView = document.getElementById('radarView');
transferAssistant = document.getElementById('transferAssistant');
myIdDisplay = document.getElementById('myIdDisplay');
peersGroup = document.getElementById('peersGroup');
radarStatus = document.getElementById('radarStatus');
messageList = document.getElementById('messageList');
messageInput = document.getElementById('messageInput');
fileInput = document.getElementById('fileInput');
peerIdDisplay = document.getElementById('peerIdDisplay');
qrcodeDiv = document.getElementById('qrcode');
modalOverlay = document.getElementById('modalOverlay');
modalTitle = document.getElementById('modalTitle');
modalMessage = document.getElementById('modalMessage');
modalCancelBtn = document.getElementById('modalCancelBtn');
modalConfirmBtn = document.getElementById('modalConfirmBtn');
sendMessageBtn = document.getElementById('sendMessageBtn');

// modalResolve 已在 config.js 中声明

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
        ws = new WebSocket(`ws://${serverUrl}`);
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
        if (radarView.style.display === 'flex') {
            // 连接后发送房间号信息
            ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId } }));
        }
    } else if (msg.type === 'same_network_clients') {
        peerNodes = msg.clients;
        updateRadarPeers(); // 在radar-detect.js中定义
        radarStatus.textContent = `发现 ${peerNodes.length} 个设备`;
    } else if (msg.type === 'new_peer') {
        if (!peerNodes.includes(msg.peer_id)) {
            peerNodes.push(msg.peer_id);
            updateRadarPeers(); // 在radar-detect.js中定义
        }
    } else if (msg.type === 'peer_left') {
        peerNodes = peerNodes.filter(id => id !== msg.peer_id);
        updateRadarPeers(); // 在radar-detect.js中定义
    } else if (msg.type === 'connect_request') {
        // 被动方收到连接请求
        handleConnectRequest(msg.from);
    } else if (msg.type === 'connect_accept') {
        // 主动方收到接受，开始交换
        startWebRTCAsInitiator(msg.from);
    } else if (msg.type === 'answer') {
        if (role === 'receiver') {
            handleRemoteAnswerCompressed(msg.payload);
        }
    } else if (msg.type === 'offer') {
        // 被动方收到offer（在连接接受后）
        handleRemoteOfferCompressed(msg.payload, msg.from);
    } else if (msg.type === 'ice') {
        handleRemoteIce(msg.payload);
    }
}

async function handleConnectRequest(fromId) {
    // 重置运营商NAT状态（全新连接）
    gatewayBurstAttempted = false;
    carrierNatHandlingStage = 0;
    carrierNatDetectedIp = null;
    carrierNatRealTimeDetectionTriggered = false;
    carrierNatReplacementMap = {};

    // 关闭旧PeerConnection（避免干扰新连接）
    if (pc) {
        pc.close();
        pc = null;
    }
    pendingIceCandidates = [];
    remoteIceCandidates = [];
    localCandidates = [];

    // 自动接受连接请求，无需确认
    targetId = fromId;
    role = 'sender'; // 被动方作为answerer
    // 通知主动方已接受
    ws.send(JSON.stringify({ type: 'connect_accept', target: fromId }));
    addLog(`[连接] 自动接受 ${fromId} 的连接请求`);
}

async function startWebRTCAsInitiator(peerId) {
    targetId = peerId;
    role = 'receiver';
    radarStatus.textContent = `连接 ${peerId}...`;
    createPeerConnection();
    createDataChannel(); // 在transfer.js中定义
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
    // gatewayBurstAttempted 在 requestConnection 中重置，不在 createPeerConnection 中重置
    // 这样可避免运营商NAT重连后再次触发检测
    const iceServers = stunServer ? [{ urls: stunServer }] : [];
    pc = new RTCPeerConnection({ iceServers });

    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        addLog(`[连接状态] ${state}`);
        document.getElementById('connStateR').textContent = state;
        if (state === 'connected') {
            showTransferAssistant(); // 在transfer.js中定义
            // 重置失败计数（不重置 gatewayBurstAttempted，避免运营商NAT处理完成后重复弹窗）
            connectionFailureCount = 0;
        } else if (state === 'failed' || state === 'disconnected') {
            connectionFailureCount++;
            addLog(`[连接失败] 状态: ${state}, 失败次数: ${connectionFailureCount}`);
            if (connectionFailureCount === 1) {
                // 第一次失败，尝试运营商NAT处理（自动爆破/询问用户）
                attemptGatewayBurstOnFailure();
            } else if (connectionFailureCount >= 2) {
                // 后续失败继续尝试（由 attemptGatewayBurstOnFailure 内部阶段控制）
                attemptGatewayBurstOnFailure();
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
            if (role === 'receiver' && genOfferSection.style.display === 'block') {
                generateCompressedQR(); // 在qr-scan.js中定义
            }
        }
    };

    pc.ondatachannel = (e) => {
        dc = e.channel;
        setupDataChannel(dc); // 在transfer.js中定义
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
        throw err; // 继续抛出，让外层的 onclick 捕获
    }
}

async function handleRemoteAnswerCompressed(compressed) {
    const { u, p, f } = compressed;
    const answerSdp = buildSDP('answer', u, p, f);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    addLog('[设置远程Answer] 成功');
    // 添加缓存ICE
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

    // 保存已在handleRemoteIce中缓存的ICE候选和远程ICE候选（createPeerConnection会清空它们）
    var savedPendingIce = pendingIceCandidates.slice();
    var savedRemoteIce = remoteIceCandidates.slice();

    createPeerConnection();
    // 恢复remoteIceCandidates，避免attemptGatewayBurstOnFailure无法提取端口
    remoteIceCandidates = savedRemoteIce;
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    for (const ic of ice) {
        await pc.addIceCandidate({ candidate: buildICECandidate(ic.ip, ic.port, ic.type, u), sdpMid: '0', sdpMLineIndex: 0 });
    }

    // 处理缓存的候选（包含运营商NAT替换后的候选）
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

// 重新连接并应用运营商NAT替换
async function reconnectWithCarrierNatReplacement(detectedCarrierNatIp, replacementIpOrIps, port) {
    addLog(`[运营商NAT重新连接] 开始重新连接，替换IP: ${detectedCarrierNatIp}`);

    // 存储替换映射
    if (Array.isArray(replacementIpOrIps)) {
        // 爆破模式：多个IP，存储整个数组
        carrierNatReplacementMap[detectedCarrierNatIp] = replacementIpOrIps;
    } else {
        // 单IP模式
        carrierNatReplacementMap[detectedCarrierNatIp] = replacementIpOrIps;
    }

    // 标记已在处理中（必须在 pc.close() 之前设置，防止旧 PC 的 onconnectionstatechange 重复触发）
    gatewayBurstAttempted = true;

    // 关闭当前连接
    if (pc) {
        pc.close();
        pc = null;
    }

    // 重置状态（保留 gatewayBurstAttempted = true）
    connectionFailureCount = 0;
    remoteIceCandidates = [];
    pendingIceCandidates = [];
    localCandidates = [];
    carrierNatRealTimeDetectionTriggered = false;

    // 根据角色重新发起连接
    if (role === 'receiver' && targetId) {
        // 主动方：重新发送连接请求
        addLog(`[运营商NAT重新连接] 主动方重新连接 ${targetId}`);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'connect_request', target: targetId }));
            radarStatus.textContent = `运营商NAT检测，重新连接 ${targetId}...`;
        }
    } else if (role === 'sender' && targetId) {
        // 被动方检测到运营商NAT：发送连接请求给主动方（角色反转重新建立连接）
        addLog(`[运营商NAT重新连接] 被动方发送连接请求给 ${targetId}`);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'connect_request', target: targetId }));
            radarStatus.textContent = `运营商NAT检测，发送连接请求给 ${targetId}...`;
        }
    } else {
        addLog(`[运营商NAT重新连接] 无法重新连接：role=${role}, targetId=${targetId}`);
    }
}

// 替换ICE候选中的IP地址
function replaceIceCandidateIp(candidateStr) {
    if (!candidateStr || typeof candidateStr !== 'string') return candidateStr;

    // 解析ICE候选字符串，格式: "candidate:... udp ... IP PORT typ ..."
    const parts = candidateStr.split(' ');
    if (parts.length < 8) return candidateStr;

    const originalIp = parts[4];
    if (!originalIp || originalIp.includes(':')) return candidateStr; // 忽略IPv6

    // 检查是否有替换映射
    const replacement = carrierNatReplacementMap[originalIp];
    if (!replacement) return candidateStr;

    // 如果是数组，使用第一个IP
    const replacementIp = Array.isArray(replacement) ? replacement[0] : replacement;

    // 替换IP
    parts[4] = replacementIp;
    return parts.join(' ');
}

// 从本地SDP中提取ice-ufrag
function extractLocalUfrag() {
    if (!pc || !pc.localDescription || !pc.localDescription.sdp) return '';
    var match = pc.localDescription.sdp.match(/a=ice-ufrag:(.+)/);
    return match ? match[1].trim() : '';
}

async function handleRemoteIce(candidateStr) {
    // === 第一步：始终解析ICE候选，无论PC是否存在 ===
    // 这样即发送方在收到offer前也能检测运营商NAT并缓存替换后的候选
    var parts = candidateStr.split(' ');
    var originalIp = parts.length >= 8 ? parts[4] : null;
    var candidatePort = parts.length >= 8 ? parseInt(parts[5], 10) : NaN;

    // === 第二步：实时运营商NAT检测 + 建立IP替换映射 ===
    // 无论是接收方还是发送方，拿到ICE就检测
    // 检测为运营商NAT即替换IP，不走平行候选，类似旧版爆破逻辑
    if (carrierNatDetectionEnabled && !gatewayBurstAttempted && !carrierNatRealTimeDetectionTriggered) {
        if (originalIp && window.isCarrierNatIp && window.isCarrierNatIp(originalIp)) {
            if (!carrierNatDetectedIp) {
                carrierNatDetectedIp = originalIp;
            }
            // 已有替换映射（例如之前手动输入的IP）则跳过
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

    // === 第三步：替换IP（如果建立了映射） ===
    var replacedCandidate = replaceIceCandidateIp(candidateStr);
    var replacedIp = replacedCandidate.split(' ')[4];

    if (originalIp !== replacedIp) {
        addLog('[ICE替换] ' + originalIp + ' -> ' + replacedIp);
    }

    // === 第四步：添加替换后的候选到ICE池或缓存 ===
    remoteIceCandidates.push(candidateStr); // 保存原始候选用于后续分析

    if (!pc) {
        // 发送方在收到offer前可能没有PC，缓存候选等offer到达后处理
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
advancedBtn.onclick = () => advancedPanel.classList.toggle('show');
applyServerBtn.onclick = () => {
    serverUrl = serverUrlInput.value.trim();
    addLog(`信令服务器: ${serverUrl}`);
};
applyStunBtn.onclick = () => {
    stunServer = stunServerInput.value.trim();
    addLog(`STUN服务器: ${stunServer}`);
};
applyRoomIdBtn.onclick = () => {
    console.log('applyRoomIdBtn clicked');
    if (!roomIdInput) {
        console.error('roomIdInput not found');
        return;
    }
    const value = roomIdInput.value.trim();
    roomId = value; // 更新房间号（空字符串表示无房间号）
    if (value) {
        addLog(`房间号已设置为: ${value}`);
        // 如果雷达模式正在运行且已连接信令，立即更新房间信息
        if (radarView.style.display === 'flex' && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId } }));
            addLog('[雷达] 房间信息已更新');
        }
    } else {
        addLog('已清除房间号，将按连接IP匹配');
        // 如果雷达模式正在运行且已连接信令，重新发送（无房间号）
        if (radarView.style.display === 'flex' && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: '' } }));
            addLog('[雷达] 房间信息已更新（无房间号，按IP匹配）');
        }
    }
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

document.getElementById('qrQuickCard').onclick = () => {
    qrQuickPanel.style.display = 'block';
    genOfferSection.style.display = 'none';
    scanSection.style.display = 'none';
};
document.getElementById('closeQrPanelBtn').onclick = () => {
    qrQuickPanel.style.display = 'none';
};

document.getElementById('showGenOfferBtn').onclick = async () => {
    qrQuickPanel.style.display = 'none';
    genOfferSection.style.display = 'block';
    role = 'receiver';

    try {
        // 第一阶段：连接信令
        addLog('[系统] 正在尝试连接信令服务器...');
        await connectSignaling();
        
        // 第二阶段：生成 WebRTC Offer
        addLog('[系统] 信令就绪，正在生成 WebRTC Offer...');
        qrcodeDiv.innerHTML = '';
        await generateOffer();
        
        addLog('[系统] Offer 生成完毕，二维码已就绪');

    } catch (e) {
        console.error("捕获到错误:", e);
        
        // 判断错误来源并给出具体提示
        if (e.message && e.message.includes('timeout')) {
            alert('信令连接超时，请检查网络或服务器地址');
        } else if (!serverConnected) {
            alert('连接信令服务器失败，请检查高级设置中的 URL');
        } else {
            // 如果走到这里，说明 connectSignaling 过了，是 generateOffer 挂了
            alert('WebRTC 逻辑出错：' + (e.message || e || '未知错误'));
        }
    }
};

document.getElementById('showScanBtn').onclick = () => {
    qrQuickPanel.style.display = 'none';
    scanSection.style.display = 'block';
};

document.getElementById('genOfferBtn').onclick = async () => {
    qrcodeDiv.innerHTML = '';
    await generateOffer();
};

document.getElementById('cancelGenOfferBtn').onclick = () => {
    genOfferSection.style.display = 'none';
    if (pc) pc.close();
};

document.getElementById('startScanBtn').onclick = startScan; // 在qr-scan.js中定义
document.getElementById('cancelScanBtn').onclick = () => {
    scanSection.style.display = 'none';
    scanningActive = false;
    const video = document.getElementById('video');
    if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop());
};

document.getElementById('radarCard').onclick = async () => {
    addLog('[系统] 正在启动雷达探测模式...');
    
    try {
        // 1. 确保信令已连接（雷达模式通常依赖信令）
        if (typeof connectSignaling === 'function') {
            addLog('[系统] 正在检查信令连接...');
            await connectSignaling();
        }

        // 2. 执行雷达核心逻辑
        addLog('[雷达] 正在扫描周边设备...');
        await startRadarMode(); 
        
        addLog('[成功] 雷达模式已激活');

    } catch(e) {
        // 打印详细错误到控制台，方便你按 F12 查看具体堆栈
        console.error('Radar Mode Error:', e);
        
        // 将具体错误通过日志显示在界面上
        addLog(`[错误] 雷达启动失败: ${e.message || e}`);
        
        // 弹出提示
        alert('连接失败，请检查信令服务器状态\n错误信息：' + (e.message || e));
    }
};

document.getElementById('closeRadarBtn').onclick = () => {
    radarView.style.display = 'none';
    if (ws) ws.close();
};

document.getElementById('closeTransferBtn').onclick = () => {
    transferAssistant.style.display = 'none';
    if (pc) pc.close();
};

sendMessageBtn.onclick = sendChatMessage; // 在transfer.js中定义
messageInput.addEventListener('keypress', (e) => { if(e.key==='Enter') sendChatMessage(); });
fileInput.onchange = (e) => {
    if (fileInput.files.length) sendFile(fileInput.files[0]); // 在transfer.js中定义
    fileInput.value = '';
};

// 连接失败时处理运营商NAT（简化2阶段：实时爆破已在handleRemoteIce中完成）
// 第1次失败 → 问用户要IP → 第2次失败 → 提示更改高级设置
async function attemptGatewayBurstOnFailure() {
    if (!carrierNatDetectionEnabled) return;

    // 如果已在处理中且没有更多阶段，跳过
    if (gatewayBurstAttempted && carrierNatHandlingStage === 0) {
        addLog('[运营商NAT] 已在处理中，跳过');
        return;
    }

    // 所有阶段已耗尽，提示用户调整设置
    if (carrierNatHandlingStage >= 2) {
        addLog('[运营商NAT] 所有方法已尝试，提示用户调整设置');
        alert('所有连接尝试均告失败。\n\n请检查:\n1. 对方是否在同一网络\n2. 高级设置中的IP爆破范围是否正确\n\n当前爆破范围: ' + gatewayBurstRange + '\n可尝试修改为其他网段，例如 192.168.0-255.1');
        return;
    }

    // 确定运营商NAT IP（优先使用实时检测到的，否则扫描候选列表）
    var carrierNatIp = carrierNatDetectedIp;
    if (!carrierNatIp && remoteIceCandidates.length > 0) {
        var info = extractRemoteIpsAndPort(remoteIceCandidates);
        carrierNatIp = info.ips.find(function(ip) { return isCarrierNatIp(ip); });
    }
    if (!carrierNatIp) {
        addLog('[运营商NAT] 未检测到运营商NAT IP');
        return;
    }

    // 提取端口
    var portInfo = remoteIceCandidates.length > 0 ? extractRemoteIpsAndPort(remoteIceCandidates) : { ips: [], port: null };
    var port = portInfo.port;
    if (!port) {
        addLog('[运营商NAT] 无法提取端口');
        return;
    }

    addLog('[运营商NAT] 处理阶段 ' + (carrierNatHandlingStage + 1) + '/2，IP: ' + carrierNatIp);

    // ===== 阶段1: 询问用户输入IP =====
    if (carrierNatHandlingStage === 0) {
        carrierNatHandlingStage = 1;
        addLog('[运营商NAT] 第1步: 询问用户输入IP');

        // 尝试使用自定义模态框，若不可用则回退到prompt
        var ip = null;
        try {
            ip = prompt('连接失败，对方IP ' + carrierNatIp + ' 为运营商NAT地址。\n\n请输入对方的内网IP地址（端口: ' + port + '）:\n例如: 192.168.1.100', '192.168.1.100');
        } catch(e) { ip = null; }

        if (!ip) {
            addLog('[运营商NAT] 用户取消输入IP');
            carrierNatHandlingStage = 0; // 允许重新尝试
            gatewayBurstAttempted = false;
            return;
        }

        // 验证IP格式
        var ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        if (!ipRegex.test(ip)) {
            alert('IP地址格式无效');
            carrierNatHandlingStage = 0;
            gatewayBurstAttempted = false;
            return;
        }

        addLog('[运营商NAT] 用户输入IP: ' + ip + '，重新连接');
        reconnectWithCarrierNatReplacement(carrierNatIp, ip, port);
        return;
    }

    // ===== 阶段2: 全部失败，提示更改设置 =====
    carrierNatHandlingStage = 2;
    alert('运营商NAT连接失败。\n\n请在高级设置中调整IP爆破范围或NAT检测正则。\n当前范围: ' + gatewayBurstRange);
}

// ===== 正则检测模式UI管理 =====

// 渲染正则检测模式列表
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

    // 绑定输入事件，实时更新检测模式
    var nameInputs = regexPatternContainer.querySelectorAll('.regex-name');
    var patternInputs = regexPatternContainer.querySelectorAll('.regex-pattern');
    for (var j = 0; j < nameInputs.length; j++) {
        (function(idx) {
            nameInputs[idx].oninput = function() { applyRegexPatternChanges(); };
            patternInputs[idx].oninput = function() { applyRegexPatternChanges(); };
        })(j);
    }
}

// 应用正则模式变更
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

// 添加新的正则模式
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

// 删除正则模式
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

// HTML转义辅助
function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 将核心函数挂载到window对象，供其他模块调用
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

// 初始化正则检测模式UI
if (addRegexPatternBtn) {
    addRegexPatternBtn.onclick = addRegexPattern;
}
// 延迟一帧渲染，确保其他初始化完成
setTimeout(function() {
    renderRegexPatternList();
    // 尝试从JSON文件加载检测规则（不影响UI渲染）
    if (window.loadCarrierNatPatternsFromJson) {
        window.loadCarrierNatPatternsFromJson().then(function() {
            renderRegexPatternList();
        });
    }
}, 100);

clearLog();
addLog('🌐 就绪，点击功能卡片开始');
})();