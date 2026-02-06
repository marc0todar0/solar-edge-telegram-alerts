FROM node:12.22.12-alpine

# Create app directory
WORKDIR /app

# Copy only what's needed to run
COPY package.json yarn.lock ./
COPY dist ./dist

# Install only production deps
RUN yarn install --production --frozen-lockfile

# No ports needed (polling bot)
CMD ["yarn", "start"]

