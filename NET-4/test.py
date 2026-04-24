import asyncio
import websockets
import json

# 存储当前连接的客户端
connected_clients = set()

async def signaling_handler(websocket):
    # 注册客户端
    connected_clients.add(websocket)
    print(f"[+] 客户端已连接。当前连接数: {len(connected_clients)}")
    
    try:
        async for message in websocket:
            # 解析消息以进行日志打印（可选），然后原样广播给其他客户端
            data = json.loads(message)
            msg_type = data.get('type', 'unknown')
            print(f"[*] 收到消息: {msg_type} from {websocket.remote_address}")
            
            # 将消息转发给除发送者之外的所有客户端
            for client in connected_clients:
                if client != websocket:
                    await client.send(message)
    except websockets.exceptions.ConnectionClosed as e:
        print(f"[-] 连接异常断开: {e}")
    finally:
        # 注销客户端
        connected_clients.remove(websocket)
        print(f"[-] 客户端已断开。当前连接数: {len(connected_clients)}")

async def main():
    # 监听所有 IPv4 和 IPv6 接口 (允许双栈访问信令服务器)
    # 注意：这里的信令服务器可以用 IPv4 访问，不影响 WebRTC P2P 使用 IPv6
    async with websockets.serve(signaling_handler, "0.0.0.0", 8765):
        print("信令服务器已启动: ws://0.0.0.0:8765")
        await asyncio.Future()  # 永久运行

if __name__ == "__main__":
    asyncio.run(main())