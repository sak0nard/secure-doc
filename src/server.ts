import { createApp } from './app'
import { ConfigError, loadConfig } from './config'
import { buildDeps } from './deps'

let config
try {
  config = loadConfig(process.env)
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message)
    process.exit(1)
  }
  throw e
}

createApp(buildDeps(config)).listen(config.port)
console.log(`listening on ${config.baseUrl.origin} (port ${config.port})`)
