# 内网直传 · 专业修复版

一个基于WebRTC的点对点内网直传应用，支持二维码连接和内网自动探查。

## 功能特性

- **二维码快速连接**：生成/扫描二维码建立WebRTC连接
- **内网自动探查**：雷达式发现同一房间号或同一连接IP下的其他设备
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
│   ├── config.js           # 全局配置和状态变量（必须最先加载）
│   ├── predict-internal.js # 内网预测和网关爆破模块（运营商NAT检测、网关爆破）
│   ├── main.js             # 主要JavaScript逻辑（WebRTC核心、信令连接、UI绑定、DOM初始化）
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

#### 1. **predict-internal.js** - 内网预测和网关爆破模块
- **运营商NAT检测**：`isCarrierNatIp()` - 检测IP是否为运营商NAT地址
- **实时IP替换**：`setupRealtimeReplacement()` - 检测到运营商NAT IP后立即建立IP替换映射
- **IP替换引擎**：`replaceIceCandidateIp()` - 透明替换ICE候选中的IP地址
- **网关IP生成**：`parseGatewayRange()` / `generateGatewayIps()` - 解析爆破范围并生成网关IP列表
- **旧版爆破**：`triggerGatewayBurst()` - 自动生成网关IP并**仅在本端添加ICE候选**（不发送给对方，作为失败回退）
- **手动IP回退**：`manualIpFallback()` - 用户手动输入内网IP并**仅在本端回退**
- **依赖**：使用main.js中的WebRTC核心函数和全局变量

#### 2. **main.js** - 全局核心逻辑
- **全局变量管理**：WebRTC连接对象、信令状态、用户身份等
- **WebRTC核心函数**：`buildSDP()`、`buildICECandidate()`、`createPeerConnection()`等
- **信令连接**：`connectSignaling()`、`handleSignalingMessage()`等WebSocket通信
- **UI事件绑定**：所有按钮点击、输入事件监听器
- **模块协调**：调用各功能模块的函数，协调整体流程

#### 3. **qr-scan.js** - 二维码扫码功能模块
- **二维码生成**：`generateCompressedQR()` - 生成压缩的WebRTC Offer二维码
- **二维码扫描**：`startScan()`、`scanLoop()` - 摄像头扫描和识别二维码
- **数据处理**：`handleScannedCompressed()` - 解析扫描数据并建立连接
- **依赖**：使用main.js中的WebRTC核心函数和全局变量

#### 4. **radar-detect.js** - 自动探测功能模块
- **网络探查**：`startRadarMode()` - 启动雷达模式，发送房间号/连接IP信息
- **设备发现**：`updateRadarPeers()` - 更新雷达界面显示发现的设备
- **连接管理**：`requestConnection()`、`handleConnectRequest()` - 处理设备连接请求
- **依赖**：与信令服务器交互，使用main.js中的全局状态

#### 5. **transfer.js** - 传输功能模块
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
    ├── js/config.js         (全局配置，必须最先加载)
    ├── js/predict-internal.js (内网预测模块)
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

服务器默认运行在 `wss://0.0.0.0:8800`

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
2. 系统自动连接信令服务器，发送房间号（如果有）
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
- **房间号**：可选，设置后仅与同一房间号的设备匹配；留空则按WebSocket连接IP自动匹配

## 浏览器兼容性

- Chrome 60+
- Firefox 55+
- Edge 79+
- Safari 11+

**注意**：需要HTTPS环境或localhost才能使用摄像头扫描功能。

## 客户端ID系统

信令服务器使用智能的ID分配机制来管理客户端连接：

### ID生成规则
- **格式**：4位易识别字符（小写字母+数字，去除了易混淆字符：0,1,i,l,o）
- **字符集**：`abcdefghjkmnpqrstuvwxyz23456789` (31个字符)
- **组合数**：31⁴ = 923,521种可能组合
- **长度**：固定4字符，短小易记

### ID管理特性
1. **可重用ID池**：断开连接的客户端ID会被回收，供新连接重用
2. **无自增限制**：不会无限增长，避免内存泄漏
3. **即时分配**：连接时立即分配，断开时立即释放
4. **唯一性保证**：在同一时间点，所有活跃客户端ID唯一

### 与传统自增ID对比
| 特性 | 旧版（自增数字） | 新版（4位字符） |
|------|----------------|----------------|
| ID长度 | 变长（1,2,3...位） | 固定4位 |
| 可读性 | 纯数字，不易识别 | 字母数字组合，易区分 |
| 资源管理 | 无限增长，不释放 | 循环重用，资源友好 |
| 最大客户端数 | 理论无限，实际受内存限制 | 同时最多923,521个 |
| 断开处理 | ID永久占用 | ID回收重用 |

### 技术优势
- **内存效率**：使用集合管理可用ID，O(1)操作复杂度
- **连接稳定性**：快速ID分配和释放，支持高频连接/断开
- **用户体验**：短ID易于识别和记忆，方便用户选择连接对象
- **系统扩展**：支持大量并发连接，ID资源自动管理

## 工作原理

1. **信令交换**：通过WebSocket服务器交换SDP和ICE信息
2. **NAT穿透**：使用STUN服务器获取公网地址
3. **连接建立**：通过ICE协议建立P2P连接
4. **数据传输**：通过RTCDataChannel传输文件和消息

## 注意事项

- 内网探查功能需要设备在同一房间号或同一WebSocket连接IP下
- 文件传输大小受浏览器内存限制
- 首次使用需要授予摄像头权限（用于二维码扫描）
- 建议在HTTPS环境下使用以确保功能完整性

## 内网预测优化

当内网自动探测失败时，系统会自动检测对方IP是否为运营商NAT地址（如 `10.x.x.x`、`172.16.x.x`、`100.64.x.x`），并采用**实时IP替换+2阶段处理**的优化策略：

### 实时IP替换（双向检测）

当**任意一方**（接收方或发送方）获取到对方的ICE候选时，系统立即检测IP是否为运营商NAT地址：

1. **直接替换IP**：检测到运营商NAT IP后，通过 `carrierNatReplacementMap` 建立替换映射，将该IP直接替换为自动生成的网关IP（如 `10.x.x.x` → `192.168.1.1`），**原IP丢弃，不再保留**
2. **零延迟接入**：替换对所有后续ICE候选透明生效，`replaceIceCandidateIp()` 在 `handleRemoteIce()` 中自动处理
3. **发送方兼容性**：发送方（被动端）在收到offer之前可能先收到ICE候选，此时将替换后的候选缓存到 `pendingIceCandidates`，待offer到达后统一处理
4. **接收方兼容性**：接收方（主动端）收到对方ICE时PC和远程描述已经就绪，替换后直接通过 `pc.addIceCandidate()` 添加

### 数据流

```
检测到运营商NAT IP → setupRealtimeReplacement()
    → 生成网关IP
    → 设置 carrierNatReplacementMap[carrierNatIp] = gatewayIp
    → 后续所有ICE候选中的 carrierNatIp 被自动替换为 gatewayIp

接收方（已有PC）: 替换后直接 addIceCandidate
发送方（PC未就绪）: 替换后缓存到 pendingIceCandidates → offer到达后处理
```

### 2阶段处理流程

实时IP替换失败后（连接仍无法建立），进入简洁的2阶段回退：

1. **询问用户输入IP（请求帮助）**：弹出 `prompt()` 让用户手动输入对方内网IP，确认后使用该IP重新连接
2. **提示调整设置（最终提示）**：所有方法均失败后，提示用户在高级设置中调整IP爆破范围或NAT检测正则

**相比旧版平行候选+3阶段流程，新版实时IP替换将爆破前移至ICE候选接收阶段，失败后仅需最多2次交互即可完成。**

### 运营商NAT检测原理

1. **实时IP检测**：当WebRTC连接过程中收到对方ICE候选IP时，立即匹配运营商NAT地址段：
   - `10.0.0.0/8` (10.x.x.x)
   - `172.16.0.0/12` (172.16.x.x - 172.31.x.x)
   - `100.64.0.0/10` (100.64.x.x - 100.127.x.x)
   - 以及用户在高级设置中自定义的正则规则

2. **自动IP替换**：检测到运营商NAT IP后，调用 `setupRealtimeReplacement()` 生成可能的网关IP，并将 `carrierNatReplacementMap` 设置为该IP。`replaceIceCandidateIp()` 透明替换所有新到达ICE候选中的运营商NAT IP。

3. **手动IP回退**：如果自动替换仍然失败，系统会提示用户手动输入对方的内网IP地址，并通过 `reconnectWithCarrierNatReplacement()` 重新建立连接。

4. **双向实时检测**：无论是发起方还是接收方，只要检测到对方为运营商NAT，都会触发实时IP替换。**发送方**通过 `handleRemoteIce()` 缓存替换后的ICE候选（无PC时），**接收方**通过同样的函数直接添加替换后的候选到ICE池。

### 核心函数

| 函数 | 作用 | 所属模块 |
|------|------|---------|
| `setupRealtimeReplacement(ip)` | 检测到运营商NAT后立即建立IP替换映射，返回替换后的IP | predict-internal.js |
| `replaceIceCandidateIp(candidate)` | 将ICE候选字符串中的IP按映射表替换 | main.js |
| `handleRemoteIce(candidateStr)` | 处理远程ICE候选：检测NAT→替换IP→添加/缓存 | main.js |
| `isCarrierNatIp(ip)` | 检测IP是否为运营商NAT地址 | predict-internal.js |
| `attemptGatewayBurstOnFailure()` | 连接失败后的2阶段处理（询问IP→提示设置） | main.js |
| `reconnectWithCarrierNatReplacement(ip, replacement)` | 用替换IP重新建立连接 | main.js |

### 实时检测 vs 旧版爆破

| 特性 | 旧版（平行候选） | 新版（IP替换） |
|------|----------------|----------------|
| 处理时机 | 连接失败后 | ICE候选到达时立即处理 |
| ICE处理方式 | 保留原候选+添加平行网关候选 | 直接替换IP，丢弃原IP |
| ufrag一致性 | 需手动构建候选，ufrag需匹配 | 保留原候选字符串，只改IP，ufrag自动正确 |
| 发送方支持 | 无检测（ICE在offer前到达被忽略） | 缓存ICE→等待offer→统一处理 |
| 代码复杂度 | 高（候选构建、状态追踪、重连逻辑） | 低（映射替换，map-based） |
| 状态追踪UI | gatewayCandidateStatus + 网关爆破状态模态框 | 无（已移除） |

### 配置选项

在高级设置中可实时调整：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| **爆破范围** | IP爆破的网关地址范围 | `192.168.43.1` |
| **NAT检测正则** | 运营商NAT IP匹配规则（可编辑/增删） | 3条默认规则 |

**爆破范围**格式说明：`192.168.1-255.1` 表示爆破 `192.168.1.1` 到 `192.168.255.1` 所有IP；`192.168.43.1` 表示只爆破单个IP。

**NAT检测正则**：高级设置中预设了3条运营商NAT匹配规则（对应 `assets/carrier-nat-patterns.json`），每条规则包含名称和正则表达式：
- 可直接编辑现有规则的名称和正则
- 点击「✕」按钮删除规则
- 点击「+ 添加正则」按钮新增规则
- 修改后实时生效，无需保存

在 `js/config.js` 中可以调整以下参数：
- `carrierNatDetectionEnabled`: 启用/禁用运营商NAT检测
- `carrierNatReplacementMap`: IP替换映射表（全局，所有模块共享）
- `gatewayBurstRange`: 网关爆破范围，默认 `"192.168.43.1"`

### 检测规则文件

运营商NAT地址段定义在 `assets/carrier-nat-patterns.json` 中，可自定义扩展。应用启动时会自动加载此文件中的正则规则，加载失败则使用内置默认规则。用户也可在高级设置中直接编辑正则表达式，修改实时生效。

## 故障排除

### 无法建立连接
1. 检查信令服务器是否正常运行
2. 确认防火墙未阻止WebSocket端口
3. 尝试更换STUN服务器
4. 如果收到ID为"0"或纯数字，请重启信令服务器以应用新版ID系统
5. 检查浏览器控制台是否有WebSocket错误信息
6. 确保信令服务器地址格式正确（IP:端口，如192.168.1.100:8800）

### 连接成功但显示错误
1. **日志显示连接成功但弹出错误提示**：通常是STUN服务器超时导致，不影响实际连接
2. **ID显示为"0"或纯数字**：信令服务器未使用新版ID系统，请重启服务器
3. **雷达模式无法发现设备**：确认房间号设置是否正确，或检查信令服务器连接是否正常
4. **反复弹出连接失败提示**：检查信令服务器日志，确认无异常断开

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