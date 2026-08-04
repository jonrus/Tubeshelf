FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run css:build

FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY drizzle ./drizzle
COPY --from=build /app/public/css/tailwind.css ./public/css/tailwind.css
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
