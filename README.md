# 3DOG Node Backend

本伺服器提供 **DSS (dead simple signalling) 服務**與**基於 LLM 的 3D 物件生成服務**。

## 技術與工具

- Node.js
- TypeScript
- Jest（測試框架）
- Playwright（瀏覽器環境／自動化依賴）

## 指令

### 安裝相依

- 開發環境（包含 devDependencies）：

```bash
npm run deps:dev
```

- 正式環境（不安裝 devDependencies）：

```bash
npm run deps:prod
```

> `pw:install` 會安裝 Playwright 瀏覽器與系統相依：`playwright install --with-deps`

### Build

```bash
npm run build
```

清除建置輸出：

```bash
npm run build:clean
```

### 啟動（Production）

先 build 再啟動：

```bash
npm run build
npm start
```

### 開發模式（含檔案變更監聽）

```bash
npm run dev
```

### 直接以 TypeScript 啟動（不經 build）

```bash
npm run start:ts
```

### 測試

```bash
npm test
```
