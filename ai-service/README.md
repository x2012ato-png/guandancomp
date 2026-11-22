# DanZero 深度蒙特卡洛（DMC）推理微服务 (`ai-service/`)

基于开源项目 `DanZero`（*DanZero: Mastering GuanDan Game with Reinforcement Learning*）预训练价值网络权重 (`q_network.ckpt`) 封装的极速推理微服务。

## 核心特点

- **纯 NumPy 矩阵推理（零 PyTorch 依赖）**：将 DanZero 的 6 层 MLP 价值网络（`567 -> 512 -> 512 -> 512 -> 512 -> 512 -> 1`）转换为纯 NumPy 矩阵运算，无需安装庞大的 PyTorch，单次 HTTP 端到端推理耗时仅 **~0.9 ms**（P99 < 3 ms）。
- **零改动兼容现有服务端 `ExternalAI` 接口**：
  - 支持 `OpenAI Chat Completions` 协议（`POST /v1/chat/completions`）
  - 支持 `LM Studio Stateful API` 增量会话协议（`POST /api/v1/chat`）
  - 支持直接 JSON 调用（`POST /decide`）

## 启动服务

```bash
# 默认监听 http://0.0.0.0:8000
npm run start:ai

# 或指定端口
PORT=8000 python3 ai-service/main.py
```

## 在游戏房间中配置使用

1. 启动 `npm run start:ai`（默认端口 `8000`）。
2. 在游戏房间中将任意机器人座位设置为 **外部 AI**：
   - **接口类型**：`OpenAI` 或 `LM Studio` 均可
   - **接口地址 (Base URL)**：`http://127.0.0.1:8000`（或 `http://localhost:8000/v1`）
   - **模型名称 (Model)**：`danzero`
   - **密钥 (API Key)**：留空即可

## 运行评测与单元测试

```bash
# 运行 Python 特征编码与推理单元测试
python3 ai-service/test_service.py

# 运行 DanZero vs 内置高级策略 AI 对战评测（自动拉起微服务对打 80 局）
npm run eval:danzero -- --seeds 10 --hands 4 --opponent advanced
```
