FROM node:22-alpine AS build

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source and build
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

# Copy pre-built UI (run build:full first, or CI step produces this)
COPY ui-dist/ ./ui-dist/

# --- Runtime image ---
FROM node:22-alpine

WORKDIR /app

# Copy only what's needed to run
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/ui-dist ./ui-dist

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/server.js"]
