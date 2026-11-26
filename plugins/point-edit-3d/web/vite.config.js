import { defineConfig } from 'vite'; import react from '@vitejs/plugin-react'; import tailwind from '@tailwindcss/vite'; import { fileURLToPath, URL } from 'node:url';
import { pointEditBridge } from './bridge.mjs';
export default defineConfig({plugins:[react(),tailwind(),pointEditBridge()],optimizeDeps:{exclude:['three-mesh-bvh']},resolve:{alias:{'@':fileURLToPath(new URL('./src',import.meta.url))}}});
