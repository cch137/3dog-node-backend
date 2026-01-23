# 3DOG (3D Object Generation) Node Backend

本伺服器提供 **基於 LLM 的 3D 物件生成服務** 與 **DSS（dead simple signalling）服務**。

## 技術與工具

- Node.js
- TypeScript
- Playwright（瀏覽器環境／自動化依賴）

## 環境變數（機密）設定

請將 `.env` 放在專案根目錄。若使用容器部署，Docker 在建置映像檔時會忽略 `.env`。容器啟動時，從啟動容器的環境動態載入；映像檔與容器內皆不會包含 `.env` 檔案。

### 必要環境變數

- `GOOGLE_GENERATIVE_AI_API_KEY`（必填）
  - Google Generative AI 的 API 金鑰
- `PORT`（選填，僅非容器環境）
  - 指定服務綁定的單一埠號
- `PORTS`（選填，僅非容器環境）
  - 指定多個埠號，以逗號分隔，例如：`3000,3001,3002`

## 指令

### 安裝

安裝開發環境所需依賴（包含開發用套件）：

```bash
npm run deps:dev
```

在 multi-stage 的 runtime 階段，若僅需執行已編譯的 JavaScript，安裝正式環境依賴即可：

```bash
npm run deps:prod
```

### 建置（Build）

將 TypeScript 專案編譯為 JavaScript，供後續以編譯結果執行：

```bash
npm run build
```

### 啟動（Production）

伺服器預設監聽 3609 埠號 (port)。提供兩種方式：

**方法一：先建置（build）後再啟動**

```bash
npm start
```

**方法二：直接以 TypeScript 啟動**

```bash
npm run start:ts
```

### 啟動（Development）

開發模式下，當 `ts`、`js` 或 `json` 檔案變更時，伺服器會自動重新啟動：

```bash
npm run dev
```

### 測試

使用 Jest 執行測試，會自動執行所有符合 `**/*.test.ts` 或 `**/*.test.js` 命名規則的測試檔案：

```bash
npm test
```

## Docker 容器部署

Docker 提供兩種方式：**自行建置 (build)** 與 **拉取雲端映像 (GHCR)** 。建議使用 GHCR 映像以簡化部署流程。

### 方式一：自行建置（build）

> 相關指令皆已封裝成 npm scripts，預設使用 `docker-compose.yml`。

建立映像（build）：

```bash
npm run docker:build
```

啟動（up）：

```bash
npm run docker:up
```

其它指令：

```bash
npm run docker:down   # 停止 / 移除（down）
npm run docker:stop   # 只停止、不移除容器（stop）
npm run docker:ps     # 查看狀態（ps）
npm run docker:logs   # 查看 logs（follow）
```

### 方式二：拉取雲端映像（GHCR，免 clone 專案）

不需要 clone 本專案；在要放置部署檔案的資料夾中（任意空資料夾即可）執行以下指令下載 `docker-compose.yml`，並將 `.env` 放在同一個資料夾內：

```bash
curl -L https://github.com/cch137/3dog-node-backend/raw/master/docker-compose.ghcr.yml -o docker-compose.yml
```

下載 / 更新映像：

```bash
docker compose pull
```

啟動（up）：

```bash
docker compose up -d
```

其它指令：

```bash
docker compose down   # 停止 / 移除（down）
docker compose stop   # 只停止、不移除容器（stop）
docker compose ps     # 查看狀態（ps）
docker compose logs   # 查看 logs（follow）
```
