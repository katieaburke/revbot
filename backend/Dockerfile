FROM node:20-alpine

WORKDIR /app

# Copy root workspace manifest + lock file
COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# Install all workspace deps
RUN npm install --legacy-peer-deps

# Copy backend source
COPY backend/ ./backend/

WORKDIR /app/backend

# Generate Prisma client and build
RUN npx prisma generate
RUN npm run build

EXPOSE 3001

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
