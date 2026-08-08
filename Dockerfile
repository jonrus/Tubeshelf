FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run css:build

FROM oven/bun:1-alpine
RUN apk add --no-cache shadow su-exec
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY drizzle ./drizzle
COPY public/icons ./public/icons
COPY public/manifest.json ./public/manifest.json
COPY --from=build /app/public/css/tailwind.css ./public/css/tailwind.css
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "run", "start"]
