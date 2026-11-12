# Explosive Racing

甩尾集氣、N2O 衝刺，再用機槍與飛彈把對手轟出賽道的網頁賽車遊戲。
電腦與手機瀏覽器都能玩，使用 three.js + TypeScript + Vite。

**線上試玩：** https://rredpanda78.github.io/explosive-racing/

## 操作

| 動作 | 鍵盤 | 手機 |
|---|---|---|
| 駕駛 | ↑ ↓ ← → | 自動油門，左下 ◀ ▶ |
| 甩尾 | Shift | 右下「甩尾」 |
| N2O | Ctrl（或空白鍵） | 「N2O」 |
| 主武器 / 副武器 | Z / X | 左側中間兩顆按鈕 |
| 後視 | C | 「後視」 |
| 重置到賽道 | R | — |
| 暫停 | Esc | 右上 II |

- 過彎按住甩尾會集氣，集滿一管得到一瓶 N2O（最多兩瓶）。
- 甩尾結束的瞬間再按一次 ↑（手機按 N2O）可觸發小噴。
- 比賽獎金與擊毀獎金可在車庫購買、安裝、升級武器與車輛。

## 開發

```bash
npm install
npm run dev      # 本機開發伺服器
npm run simtest  # 無畫面模擬測試（AI 跑完整場 + 甩尾檢查）
npm run build    # 型別檢查並打包到 dist/
```

推送到 `main` 後，GitHub Actions 會自動打包並部署到 GitHub Pages。

## 程式結構

- `src/game/`：純模擬邏輯，不依賴畫面（賽道、甩尾物理、武器、AI、比賽流程）。之後做連線對戰時由主機端直接執行。
- `src/render/`：three.js 畫面（賽道場景、車輛模型、粒子特效、鏡頭）。
- `src/ui/`：HUD、選單、車庫、結算畫面。
- `src/game/config.ts`：手感與平衡參數集中在這裡。

目前車輛與場景都是程式生成的幾何模型，之後可替換成 glTF 模型。
