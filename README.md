# 3DOG Node Backend

本伺服器提供 **DSS (dead simple signalling) 服務**與**基於 LLM 的 3D 物件生成服務**。

## 技術與工具

- Node.js
- TypeScript
- Jest（測試框架）
- Playwright（瀏覽器環境／自動化依賴）

## 環境變數（機密）設定

請將 `.env` 放在專案根目錄。若使用容器部署，Docker 在建置映像檔時會忽略 `.env`，並於容器啟動時從執行環境動態載入。映像檔與容器內皆不會包含 `.env` 檔案。

### 必要環境變數

- `GOOGLE_GENERATIVE_AI_API_KEY`（必填）
  - Google Generative AI 的 API 金鑰。
- `PORT`（選填，僅非容器環境）
  - 指定服務綁定的單一埠號。
- `PORTS`（選填，僅非容器環境）
  - 指定多個埠號，以逗號分隔，例如：`3000,3001,3002`。

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

## Docker 容器部署

容器環境下，伺服器預設監聽 3609 埠號 (port)。

Docker 分為兩種方式：**自行建置（build）**與**拉取雲端檔案（GHCR）**。

### 方式一：自行建置（build）

> 相關指令皆已封裝成 npm scripts，預設使用 `docker-compose.yml`。

建立 image（build）：

```bash
npm run docker:build
```

啟動服務（up）：

```bash
npm run docker:up
```

停止 / 移除（down）：

```bash
npm run docker:down
```

只停止、不移除容器（stop）：

```bash
npm run docker:stop
```

查看狀態（ps）：

```bash
npm run docker:ps
```

查看 logs（follow）：

```bash
npm run docker:logs
```

---

### 方式二：拉取雲端檔案（GHCR，免 clone 專案）

不需要 clone 本專案；在你要放置部署檔案的資料夾中（任意空資料夾即可）執行以下指令下載 `docker-compose.yml`，並將 `.env` 放在同一個資料夾內：

```bash
curl -L https://github.com/cch137/3dog-node-backend/raw/master/docker-compose.ghcr.yml -o docker-compose.yml
```

下載 / 更新映像：

```bash
docker compose pull
```

啟動（背景執行）：

```bash
docker compose up -d
```

停止 / 移除（down）：

```bash
docker compose down
```

只停止、不移除容器（stop）：

```bash
docker compose stop
```

查看狀態（ps）：

```bash
docker compose ps
```

查看 logs（follow）：

```bash
docker compose logs
```
