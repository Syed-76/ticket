FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/src ./src
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/ecosystem.config.cjs ./ecosystem.config.cjs
RUN mkdir -p data transcripts
EXPOSE 3000
CMD ["node", "src/index.js"]
