FROM node:20-slim

WORKDIR /app

# Install build tools for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --production

COPY src/ ./src/

# Create data directory
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/index.js"]
