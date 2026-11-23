import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const FIREBASE_PROJECT = process.env.VITE_FIREBASE_PROJECT_ID || 'demo-eye-academy'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // nitro() builds the server for the host it detects (Vercel on Vercel, Node locally).
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart(),
    nitro({
      routeRules: {
        // Serve Firebase's auth handler from our own origin so Google sign-in stays
        // first-party (browsers that partition third-party storage otherwise drop
        // the session on the way back from Google). On Vercel these become CDN rewrites.
        '/__/auth/**': { proxy: `https://${FIREBASE_PROJECT}.firebaseapp.com/__/auth/**` },
        '/__/firebase/**': { proxy: `https://${FIREBASE_PROJECT}.firebaseapp.com/__/firebase/**` },
      },
      // Ship the Admin SDK's Firestore client as real node_modules instead of
      // bundling it: it loads its protobuf files relative to __dirname, which
      // does not exist once inlined into an ES module bundle.
      traceDeps: ['firebase-admin', '@google-cloud/firestore', 'google-gax'],
      // Run server functions near the users (UK) rather than the default US region.
      vercel: { functions: { regions: ['lhr1'] } },
    }),
    viteReact(),
  ],
})

export default config
