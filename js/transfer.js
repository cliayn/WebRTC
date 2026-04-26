// 传输功能模块（连接成功后发送文本和文件）
// 依赖的全局变量：dc, targetId, receiveBuffer, receivedFileName, receivedFileSize
// 注意：多连接模式下，setupDataChannelForPeer (main.js) 会覆盖此文件的handler
// 此文件的函数仅用于兼容旧流程和过渡期

// 设置数据通道（会被 setupDataChannelForPeer 覆盖）
function setupDataChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
        addLog('[数据通道] 已打开');
        if (typeof messageList !== 'undefined' && messageList) {
            addMessage('system', '数据通道已建立');
        }
    };
    channel.onclose = () => addLog('[数据通道] 关闭');
    channel.onmessage = (e) => {
        if (typeof e.data === 'string') {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'file-meta') {
                    receivedFileName = msg.name;
                    receivedFileSize = msg.size;
                    receiveBuffer = [];
                    if (typeof messageList !== 'undefined' && messageList) {
                        addMessage('system', `准备接收: ${msg.name}`);
                    }
                } else if (msg.type === 'file-end') {
                    const blob = new Blob(receiveBuffer);
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = receivedFileName;
                    a.click();
                    URL.revokeObjectURL(a.href);
                    if (typeof messageList !== 'undefined' && messageList) {
                        addMessage('system', `接收完成`);
                    }
                } else if (msg.type === 'chat') {
                    if (typeof messageList !== 'undefined' && messageList) {
                        addMessage('peer', msg.text);
                    }
                }
            } catch(ex){}
        } else if (e.data instanceof ArrayBuffer) {
            receiveBuffer.push(e.data);
        }
    };
}

// 创建数据通道
function createDataChannel() {
    dc = pc.createDataChannel('fileTransfer');
    setupDataChannel(dc);
}

// 显示传输助手界面（旧版兼容）
function showTransferAssistant() {
    // 不再使用全局 transferAssistant，多连接模式使用 peerTabs
    if (typeof transferAssistant !== 'undefined' && transferAssistant) {
        transferAssistant.style.display = 'flex';
        if (typeof peerIdDisplay !== 'undefined' && peerIdDisplay) {
            peerIdDisplay.textContent = `与 ${targetId || '对方'} 连接中`;
        }
    }
}

// 添加消息到消息列表（旧版兼容，多连接模式使用 addPeerMessage）
function addMessage(sender, text) {
    var ml = (typeof messageList !== 'undefined') ? messageList : null;
    if (!ml) return;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble' + (sender === 'self' ? ' self' : '');
    bubble.textContent = text;
    ml.appendChild(bubble);
    ml.scrollTop = ml.scrollHeight;
}

// 发送聊天消息（旧版兼容，会被 main.js 的版本覆盖）
function sendChatMessage() {
    var mi = (typeof messageInput !== 'undefined') ? messageInput : null;
    if (!mi) return;
    const text = mi.value.trim();
    if (!text || !dc || dc.readyState !== 'open') return;
    dc.send(JSON.stringify({ type: 'chat', text }));
    addMessage('self', text);
    mi.value = '';
}

// 发送文件（旧版兼容，会被 main.js 的版本覆盖）
function sendFile(file) {
    var fi = (typeof fileInput !== 'undefined') ? fileInput : null;
    if (!dc || dc.readyState !== 'open') return;
    dc.send(JSON.stringify({type:'file-meta', name:file.name, size:file.size}));
    const chunkSize = 16*1024;
    let offset = 0;
    const reader = new FileReader();
    reader.onload = (e) => {
        dc.send(e.target.result);
        offset += e.target.result.byteLength;
        if (offset < file.size) readNext();
        else { dc.send(JSON.stringify({type:'file-end'})); addMessage('system', `发送完成`); }
    };
    const readNext = () => reader.readAsArrayBuffer(file.slice(offset, offset+chunkSize));
    readNext();
}

// 将函数挂载到window对象
window.setupDataChannel = setupDataChannel;
window.createDataChannel = createDataChannel;
window.showTransferAssistant = showTransferAssistant;
window.addMessage = addMessage;
window.sendChatMessage = sendChatMessage;
window.sendFile = sendFile;
