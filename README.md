# Node Server

本伺服器提供 **DSS (dead simple signalling) 服務** 與 **Realtime AI 控制服務**。

## 技術與工具

- Node.js
- Jest（測試框架）
- Playwright（瀏覽器環境／自動化依賴）

## 指令

### 安裝相依

首次使用或更新相依後，請先安裝套件並安裝 Playwright 瀏覽器：

```bash
npm i
npx playwright install
```

### 啟動（Production）

以正式模式啟動服務：

```bash
npm start
```

### 開發模式（含檔案變更監聽）

以開發模式啟動，並在檔案變更時自動重新載入：

```bash
npm run dev
```

### 測試

執行測試（使用 **Jest**；會自動搜尋並執行 `*.test.ts` / `*.test.js` 等測試檔）：

```bash
npm test
```

或

```bash
npm t
```
