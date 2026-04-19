// 自动探测功能模块
// 依赖的全局变量：publicIpInfo, manualPublicIpInfo, peerNodes, ws, stunServer, targetId, role
// 依赖的全局函数：addLog, connectSignaling, showModal
// 依赖的DOM元素：radarView, radarStatus, peersGroup, myIdDisplay

// 开始雷达模式
async function startRadarMode() {
    radarView.style.display = 'flex';
    radarStatus.textContent = '获取网络信息...';
    // 优先使用手动设置的公网IP/端口
    if (manualPublicIpInfo) {
        publicIpInfo = manualPublicIpInfo;
        radarStatus.textContent = `公网: ${publicIpInfo.public_ip}:${publicIpInfo.public_port} (手动设置)`;
        addLog(`使用手动公网IP/端口: ${publicIpInfo.public_ip}:${publicIpInfo.public_port}`);
        await connectSignaling();
        return;
    }
    // 否则通过STUN获取
    const iceServers = stunServer ? [{ urls: stunServer }] : [];
    const pcTemp = new RTCPeerConnection({ iceServers });
    pcTemp.createDataChannel('dummy');
    const offer = await pcTemp.createOffer();
    await pcTemp.setLocalDescription(offer);
    const iceCandidate = await new Promise((resolve) => {
        pcTemp.onicecandidate = (e) => {
            if (e.candidate && e.candidate.candidate.includes('srflx')) resolve(e.candidate);
        };
        setTimeout(() => resolve(null), 3000);
    });
    pcTemp.close();
    if (iceCandidate) {
        const parts = iceCandidate.candidate.split(' ');
        publicIpInfo = { public_ip: parts[4], public_port: parseInt(parts[5]) };
        radarStatus.textContent = `公网: ${parts[4]}:${parts[5]}`;
    } else {
        publicIpInfo = { public_ip: 'unknown', public_port: 0 };
    }
    await connectSignaling();
}

// 更新雷达中的设备节点
function updateRadarPeers() {
    const group = peersGroup;
    group.innerHTML = '';
    const center = { x: 200, y: 200 };
    const radius = 140;
    peerNodes.forEach((pid, index) => {
        const angle = (index / Math.max(peerNodes.length, 1)) * 2 * Math.PI;
        const x = center.x + radius * Math.cos(angle);
        const y = center.y + radius * Math.sin(angle);
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', x);
        circle.setAttribute('cy', y);
        circle.setAttribute('r', '20');
        circle.setAttribute('fill', '#0d9488');
        circle.setAttribute('stroke', '#5eead4');
        circle.setAttribute('stroke-width', '2');
        circle.setAttribute('class', 'peer-node');
        circle.setAttribute('data-id', pid);
        circle.addEventListener('click', () => requestConnection(pid));
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', x);
        text.setAttribute('y', y+5);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', 'white');
        text.setAttribute('font-size', '12');
        text.textContent = pid;
        group.appendChild(circle);
        group.appendChild(text);
    });
}

// 请求连接到设备
async function requestConnection(peerId) {
    const confirmed = await showModal('发起连接', `确定要连接设备 ${peerId} 吗？`);
    if (confirmed) {
        targetId = peerId;
        ws.send(JSON.stringify({ type: 'connect_request', target: peerId }));
        radarStatus.textContent = `已发送连接请求给 ${peerId}，等待接受...`;
    }
}

// 处理连接请求（从信令模块调用）
async function handleConnectRequest(fromId) {
    const confirmed = await showModal('连接请求', `设备 ${fromId} 请求与您建立连接，是否接受？`);
    if (confirmed) {
        targetId = fromId;
        role = 'sender'; // 被动方作为answerer
        // 通知主动方已接受
        ws.send(JSON.stringify({ type: 'connect_accept', target: fromId }));
        addLog(`[连接] 已接受 ${fromId} 的连接请求`);
    }
}