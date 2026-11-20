FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json environment.d.ts ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/bot.js"]
