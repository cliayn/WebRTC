// 自动探测功能模块（房间号版）
// 依赖的全局变量：roomId, peerNodes, ws, targetId, role
// 依赖的全局函数：addLog, connectSignaling, showModal
// 依赖的DOM元素：radarView, radarStatus, peersGroup, myIdDisplay

// 开始雷达模式
async function startRadarMode() {
    // 雷达始终可见，无需设置display

    // 显示房间号信息
    if (roomId) {
        radarStatus.textContent = `房间号: ${roomId} (等待同房间设备...)`;
        addLog(`使用房间号: ${roomId}`);
    } else {
        radarStatus.textContent = '无房间号，按连接IP匹配设备...';
        addLog('[雷达] 无房间号，将按连接IP匹配');
    }

    // 连接信令服务器（房间信息将在连接后的 ok 消息处理中发送）
    try {
        await connectSignaling();
    } catch (connectError) {
        addLog('[雷达] 信令连接失败: ' + connectError);
        throw connectError;
    }
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
        // 使用 <g> 包裹圆形和文本，使整个区域（包括用户ID文字）可点击
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'peer-node');
        g.setAttribute('data-id', pid);
        g.style.cursor = 'pointer';
        g.addEventListener('click', () => requestConnection(pid));
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', x);
        circle.setAttribute('cy', y);
        circle.setAttribute('r', '20');
        circle.setAttribute('fill', '#0d9488');
        circle.setAttribute('stroke', '#5eead4');
        circle.setAttribute('stroke-width', '2');
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', x);
        text.setAttribute('y', y+5);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', 'white');
        text.setAttribute('font-size', '12');
        text.setAttribute('pointer-events', 'none');
        text.textContent = pid;
        g.appendChild(circle);
        g.appendChild(text);
        group.appendChild(g);
    });
}

// 请求连接到设备（需要对方确认）
async function requestConnection(peerId) {
    targetId = peerId;
    // 重置运营商NAT处理状态（全新连接）
    gatewayBurstAttempted = false;
    carrierNatHandlingStage = 0;
    carrierNatDetectedIp = null;
    carrierNatRealTimeDetectionTriggered = false;
    carrierNatReplacementMap = {};

    // 显示加载覆盖层
    if (window.showLoadingOverlay) {
        window.showLoadingOverlay('正在请求与 ' + peerId + ' 连接，等待对方确认...');
    }

    ws.send(JSON.stringify({ type: 'connect_request', target: peerId }));
    radarStatus.textContent = `已发送连接请求给 ${peerId}，等待对方确认...`;
    addLog(`[雷达] 连接请求发送至 ${peerId}，等待对方确认`);
}

// 将函数挂载到window对象
window.startRadarMode = startRadarMode;
window.updateRadarPeers = updateRadarPeers;
window.requestConnection = requestConnection;
