# syntax=docker/dockerfile:1

# ---------- build: install everything, compile frontend and backend
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci
COPY . .
RUN npm run build

# ---------- runtime: production dependencies and compiled output only
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --omit=dev --workspace backend --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/backend/db backend/db
COPY --from=build /app/frontend/dist frontend/dist
COPY --from=build /app/index.html index.html

USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/dist/index.js"]
