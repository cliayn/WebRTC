// 传输功能模块 - 多连接聊天和文件传输
// 依赖的全局变量：connections, activePeerId, dc, pc
// 依赖的全局函数：addLog（main.js 中定义，运行时可用）

// 创建数据通道（最简版本，handler 由 setupDataChannelForPeer 覆写）
function createDataChannel() {
    dc = pc.createDataChannel('fileTransfer');
    dc.binaryType = 'arraybuffer';
    dc.onopen = function() { addLog('[数据通道] 已创建'); };
    dc.onclose = function() { addLog('[数据通道] 关闭'); };
}

// 为指定对等端设置数据通道处理器
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
                    addLog('[同步断开] ' + peerId + ' 已断开连接');
                    addPeerMessage(peerId, 'system', '对方已断开连接');
                    setTimeout(function() {
                        if (window.cleanupConnection) window.cleanupConnection(peerId);
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

// 创建对等端聊天容器（从模板克隆）
function createPeerChatContainer(peerId) {
    var template = document.getElementById('transferTemplate');
    if (!template) return null;
    var tabs = document.getElementById('peerTabs');
    if (!tabs) return null;

    var existing = tabs.querySelector('.peer-chat-container[data-peerid="' + peerId + '"]');
    if (existing) return existing;

    var container = template.querySelector('.peer-chat-container').cloneNode(true);
    container.setAttribute('data-peerid', peerId);
    container.querySelector('.transfer-peer-id').textContent = peerId;

    var menuToggle = container.querySelector('.chat-menu-toggle');
    menuToggle.onclick = function() { if (window.toggleSidebar) window.toggleSidebar(); };

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

    if (connections[peerId] && connections[peerId].messages) {
        var existingMsgs = connections[peerId].messages;
        connections[peerId].messages = [];
        for (var i = 0; i < existingMsgs.length; i++) {
            addPeerMessage(peerId, existingMsgs[i].sender, existingMsgs[i].text);
        }
    }

    return container;
}

// 添加消息到对等端聊天
function addPeerMessage(peerId, sender, text) {
    var container = document.querySelector('#peerTabs .peer-chat-container[data-peerid="' + peerId + '"]');
    if (!container) return;
    var msgList = container.querySelector('.transfer-messages');
    if (!msgList) return;

    var wrapper = document.createElement('div');
    if (sender === 'self') wrapper.className = 'message-wrapper self-msg';
    else if (sender === 'system') wrapper.className = 'message-wrapper system-msg';
    else wrapper.className = 'message-wrapper peer-msg';

    var bubble = document.createElement('div');
    bubble.className = 'message';
    bubble.textContent = text;
    wrapper.appendChild(bubble);
    msgList.appendChild(wrapper);

    var chatContainer = container.querySelector('.chat-container');
    if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;

    if (connections[peerId]) {
        connections[peerId].messages.push({ sender: sender, text: text });
    }
}

// 兼容旧版：全局 sendChatMessage（无参形式使用 activePeerId）
function sendChatMessage() {
    if (activePeerId) {
        var container = document.querySelector('#peerTabs .peer-chat-container[data-peerid="' + activePeerId + '"]');
        if (container) {
            var sendBtn = container.querySelector('.send-msg-btn');
            if (sendBtn) sendBtn.onclick();
        }
    }
}

// 兼容旧版：全局 sendFile
function sendFile(file) {
    if (activePeerId) {
        var conn = connections[activePeerId];
        if (conn && conn.dc) {
            sendFileOverDC(conn.dc, file, activePeerId);
        }
    }
}

// 旧版 showTransferAssistant（多连接模式不再使用）
function showTransferAssistant() {}

// 旧版 addMessage（兼容层，转发到 addPeerMessage）
function addMessage(sender, text) {
    if (activePeerId) {
        addPeerMessage(activePeerId, sender, text);
    }
}

// 导出
window.createDataChannel = createDataChannel;
window.setupDataChannelForPeer = setupDataChannelForPeer;
window.sendFileOverDC = sendFileOverDC;
window.createPeerChatContainer = createPeerChatContainer;
window.addPeerMessage = addPeerMessage;
window.sendChatMessage = sendChatMessage;
window.sendFile = sendFile;
window.showTransferAssistant = showTransferAssistant;
window.addMessage = addMessage;
