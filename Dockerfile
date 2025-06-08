# Use Node.js LTS Alpine for smaller image size
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install openssh for key generation (if needed)
RUN apk add --no-cache openssh-keygen

# Create non-root user for security
RUN addgroup -g 1001 -S tetris && \
    adduser -S tetris -u 1001 -G tetris

# Copy package files first (for better Docker layer caching)
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY tetris-server.js ./

# Create data directory for persistent storage
RUN mkdir -p /app/data && chown -R tetris:tetris /app/data

# Generate SSH host key if it doesn't exist
RUN if [ ! -f ssh_host_key ]; then \
        ssh-keygen -t rsa -b 4096 -f ssh_host_key -N "" -C "tetris-server"; \
    fi

# Set proper permissions
RUN chown -R tetris:tetris /app && \
    chmod 600 ssh_host_key && \
    chmod 644 ssh_host_key.pub

# Switch to non-root user
USER tetris

# Expose SSH port
EXPOSE 2222

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD netstat -an | grep :2222 || exit 1

# Set data directory as volume
VOLUME ["/app/data"]

# Start the server
CMD ["node", "tetris-server.js"]