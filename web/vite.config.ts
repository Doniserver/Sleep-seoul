import { defineConfig } from "vite";

// GitHub Pages(하위 경로)에서도 동작하도록 상대 경로로 빌드
export default defineConfig({
  base: "./",
  envDir: "..",   // 프로젝트 맨 위의 .env에서 VITE_ 로 시작하는 값만 읽음 (다른 키는 브라우저로 나가지 않음)
  build: { outDir: "dist", chunkSizeWarningLimit: 1500 },
});
