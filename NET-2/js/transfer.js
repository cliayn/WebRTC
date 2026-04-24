// 传输功能模块（连接成功后发送文本和文件）
// 依赖的全局变量：dc, targetId, receiveBuffer, receivedFileName, receivedFileSize
// 依赖的DOM元素：transferAssistant, peerIdDisplay, messageList, messageInput, fileInput

// 设置数据通道
function setupDataChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
        addLog('[数据通道] 已打开');
        addMessage('system', '数据通道已建立');
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
                    addMessage('system', `准备接收: ${msg.name}`);
                } else if (msg.type === 'file-end') {
                    const blob = new Blob(receiveBuffer);
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = receivedFileName;
                    a.click();
                    URL.revokeObjectURL(a.href);
                    addMessage('system', `接收完成`);
                } else if (msg.type === 'chat') {
                    addMessage('peer', msg.text);
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

// 显示传输助手界面
function showTransferAssistant() {
    transferAssistant.style.display = 'flex';
    peerIdDisplay.textContent = `与 ${targetId || '对方'} 连接中`;
}

// 添加消息到消息列表
function addMessage(sender, text) {
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble' + (sender === 'self' ? ' self' : '');
    bubble.textContent = text;
    messageList.appendChild(bubble);
    messageList.scrollTop = messageList.scrollHeight;
}

// 发送聊天消息
function sendChatMessage() {
    const text = messageInput.value.trim();
    if (!text || !dc || dc.readyState !== 'open') return;
    dc.send(JSON.stringify({ type: 'chat', text }));
    addMessage('self', text);
    messageInput.value = '';
}

// 发送文件
function sendFile(file) {
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