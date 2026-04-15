#!/usr/bin/env python3
# signaling_server.py
# 详细日志版

import asyncio
import json
import logging
import argparse
from websockets.server import serve
from websockets.exceptions import ConnectionClosed

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%H:%M:%S'
)

class SignalingServer:
    def __init__(self):
        self.clients = {}
        self.counter = 0

    async def handler(self, websocket):
        client_id = str(self.counter)
        self.counter += 1
        self.clients[client_id] = websocket
        logging.info(f"[连接] 客户端已连接，分配 ID: {client_id}")

        try:
            # 发送欢迎消息，包含分配的ID
            await websocket.send(json.dumps({"type": "ok", "id": client_id}))
            logging.info(f"[发送] -> 客户端 {client_id}: {json.dumps({'type':'ok','id':client_id})}")

            async for message in websocket:
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    logging.warning(f"[错误] 无效 JSON: {message}")
                    continue

                msg_type = data.get("type")
                target_id = data.get("target")
                payload = data.get("payload")

                logging.info(f"[接收] 来自 {client_id} -> 目标 {target_id}: type={msg_type}, payload={json.dumps(payload, ensure_ascii=False)}")

                if msg_type == "ping":
                    await websocket.send(json.dumps({"type": "pong"}))
                    logging.info(f"[发送] -> {client_id}: pong")

                elif msg_type in ("offer", "answer", "ice"):
                    if target_id and target_id in self.clients:
                        forward_msg = {
                            "type": msg_type,
                            "from": client_id,
                            "payload": payload
                        }
                        await self.clients[target_id].send(json.dumps(forward_msg))
                        logging.info(f"[转发] 从 {client_id} 到 {target_id}: {json.dumps(forward_msg)}")
                    else:
                        logging.warning(f"[警告] 目标 {target_id} 不存在，无法转发")

                elif msg_type == "get_id":
                    await websocket.send(json.dumps({"type": "id", "id": client_id}))
                    logging.info(f"[发送] -> {client_id}: id={client_id}")

                else:
                    logging.warning(f"[未知] 未知消息类型: {msg_type}")

        except ConnectionClosed:
            logging.info(f"[断开] 客户端 {client_id} 断开连接")
        finally:
            if client_id in self.clients:
                del self.clients[client_id]
                logging.info(f"[清理] 客户端 {client_id} 已移除")

async def main(host, port):
    server = SignalingServer()
    async with serve(server.handler, host, port):
        logging.info(f"信令服务器运行在 ws://{host}:{port}")
        await asyncio.Future()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8800)
    args = parser.parse_args()
    asyncio.run(main(args.host, args.port))