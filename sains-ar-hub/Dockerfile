FROM node:20-slim

WORKDIR /app

# Copy package files and install ALL deps (sqlite needed at runtime for POC)
COPY package.json package-lock.json* ./
RUN npm install

# Copy application source
COPY . .

# Deploy CDS schema + seed data to SQLite
ENV CDS_ENV=poc
ENV NODE_ENV=development
RUN npx cds deploy

# Expose port
EXPOSE 4004

# Start
CMD ["npx", "cds", "serve"]
