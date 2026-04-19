# 内网直传 · 专业修复版

一个基于WebRTC的点对点内网直传应用，支持二维码连接和内网自动探查。

## 功能特性

- **二维码快速连接**：生成/扫描二维码建立WebRTC连接
- **内网自动探查**：雷达式发现同一公网IP下的其他设备
- **文件传输**：通过WebRTC数据通道传输文件
- **实时聊天**：支持文本消息通信
- **高级配置**：可自定义信令服务器和STUN服务器

## 项目结构

```
.
├── index.html              # 主页面
├── css/
│   └── style.css           # 样式文件
├── js/                     # JavaScript逻辑模块
│   ├── main.js             # 主要JavaScript逻辑（全局变量、WebRTC核心、信令连接、UI绑定）
│   ├── qr-scan.js          # 二维码扫码功能模块（生成/扫描二维码）
│   ├── radar-detect.js     # 自动探测功能模块（内网雷达发现、设备连接）
│   └── transfer.js         # 传输功能模块（文件传输、实时聊天）
├── assets/                 # WebRTC配置模板
│   ├── sdp-template.json   # SDP模板配置文件（offer/answer格式说明）
│   └── ice-template.json   # ICE候选模板配置文件（候选类型、格式说明）
├── server.py               # 信令服务器（Python）
└── README.md               # 项目说明
```

## 核心逻辑架构

### JavaScript模块分工

本项目采用模块化设计，将功能按职责分离到不同的JS文件中：

#### 1. **main.js** - 全局核心逻辑
- **全局变量管理**：WebRTC连接对象、信令状态、用户身份等
- **WebRTC核心函数**：`buildSDP()`、`buildICECandidate()`、`createPeerConnection()`等
- **信令连接**：`connectSignaling()`、`handleSignalingMessage()`等WebSocket通信
- **UI事件绑定**：所有按钮点击、输入事件监听器
- **模块协调**：调用各功能模块的函数，协调整体流程

#### 2. **qr-scan.js** - 二维码扫码功能模块
- **二维码生成**：`generateCompressedQR()` - 生成压缩的WebRTC Offer二维码
- **二维码扫描**：`startScan()`、`scanLoop()` - 摄像头扫描和识别二维码
- **数据处理**：`handleScannedCompressed()` - 解析扫描数据并建立连接
- **依赖**：使用main.js中的WebRTC核心函数和全局变量

#### 3. **radar-detect.js** - 自动探测功能模块
- **网络探查**：`startRadarMode()` - 启动雷达模式，获取公网IP信息
- **设备发现**：`updateRadarPeers()` - 更新雷达界面显示发现的设备
- **连接管理**：`requestConnection()`、`handleConnectRequest()` - 处理设备连接请求
- **依赖**：与信令服务器交互，使用main.js中的全局状态

#### 4. **transfer.js** - 传输功能模块
- **数据通道设置**：`setupDataChannel()`、`createDataChannel()` - 配置WebRTC数据通道
- **文件传输**：`sendFile()` - 分块传输文件
- **实时聊天**：`sendChatMessage()`、`addMessage()` - 文本消息发送和显示
- **界面管理**：`showTransferAssistant()` - 显示传输助手界面
- **依赖**：依赖WebRTC数据通道，使用main.js中的连接对象

### 配置文件说明

#### assets/sdp-template.json
- **用途**：SDP（Session Description Protocol）模板配置文件
- **内容**：offer/answer格式示例、字段说明、SDP生成模板
- **参考**：开发时可参考此文件理解SDP结构和字段含义

#### assets/ice-template.json
- **用途**：ICE（Interactive Connectivity Establishment）候选模板配置文件
- **内容**：ICE候选类型说明、完整格式和压缩格式示例、优先级值
- **参考**：帮助理解ICE候选的格式和解析方式

### 模块依赖关系

```
index.html
    ├── js/qr-scan.js        (功能模块1)
    ├── js/radar-detect.js   (功能模块2)
    ├── js/transfer.js       (功能模块3)
    └── js/main.js           (核心模块，最后加载)
```

**加载顺序**：功能模块先加载，main.js最后加载，确保所有函数定义可用。

**数据流**：各模块通过全局作用域共享变量和函数，保持功能解耦但数据互通。

## 快速开始

### 1. 启动信令服务器

```bash
python server.py --host 0.0.0.0 --port 8800
```

服务器默认运行在 `ws://0.0.0.0:8800`

### 2. 打开客户端

直接使用浏览器打开 `index.html`，或通过HTTP服务器访问：

```bash
python -m http.server 8000
```

然后在浏览器中访问 `http://localhost:8000`

### 3. 配置服务器地址

在应用的高级设置中，将信令服务器地址修改为实际运行服务器的IP和端口。

## 使用说明

### 二维码快速连接

1. 点击"二维码快速连接"卡片
2. 选择"生成 Offer 二维码"或"扫描二维码"
3. 生成二维码方等待连接
4. 扫描二维码方扫描并建立连接

### 内网自动探查

1. 点击"内网自动探查"卡片
2. 系统自动获取公网IP信息
3. 雷达界面显示同一网络下的其他设备
4. 点击设备节点发起连接请求

### 文件传输

连接建立后，自动打开传输助手界面：
- 发送文件：点击📎按钮选择文件
- 发送消息：输入文本后点击发送或按Enter键
- 接收文件：自动下载到本地

## 技术栈

- **前端**：HTML5、CSS3、JavaScript (ES6+)
- **WebRTC**：RTCPeerConnection、RTCDataChannel
- **信令**：WebSocket
- **二维码**：qrcode.js、jsQR
- **服务器**：Python + websockets

## 配置说明

### 信令服务器

修改 `server.py` 启动参数：
- `--host`：监听地址（默认：0.0.0.0）
- `--port`：监听端口（默认：8800）

### 客户端配置

在高级设置中可修改：
- **信令服务器地址**：WebSocket服务器地址（IP:端口）
- **STUN服务器**：用于NAT穿透的STUN服务器地址

## 浏览器兼容性

- Chrome 60+
- Firefox 55+
- Edge 79+
- Safari 11+

**注意**：需要HTTPS环境或localhost才能使用摄像头扫描功能。

## 工作原理

1. **信令交换**：通过WebSocket服务器交换SDP和ICE信息
2. **NAT穿透**：使用STUN服务器获取公网地址
3. **连接建立**：通过ICE协议建立P2P连接
4. **数据传输**：通过RTCDataChannel传输文件和消息

## 注意事项

- 内网探查功能需要设备有公网IP或在同一NAT后
- 文件传输大小受浏览器内存限制
- 首次使用需要授予摄像头权限（用于二维码扫描）
- 建议在HTTPS环境下使用以确保功能完整性

## 故障排除

### 无法建立连接
1. 检查信令服务器是否正常运行
2. 确认防火墙未阻止WebSocket端口
3. 尝试更换STUN服务器

### 二维码扫描失败
1. 确保已授予摄像头权限
2. 检查摄像头是否被其他应用占用
3. 确保环境光线充足

### 文件传输中断
1. 检查网络连接稳定性
2. 尝试减小文件大小
3. 重新建立连接

## 许可证

本项目仅供学习和研究使用。