export class Cache {
  constructor() {
    this.cache = new Map()
    this.tokens = new Map()
    this.timeouts = new Map()

    this.registry = new FinalizationRegistry(key => {
      console.log('自动清除 失效缓存', key);
      this.cache.delete(key)
      this.tokens.delete(key)
      this.timeouts.delete(key)
    })
  }
  /**
   * 添加缓存项
   * @param {string} key - 缓存键
   * @param {object} value - 缓存值（必须是对象，WeakRef 不能引用原始类型）
   * @param {number} ttl - 可选的过期时间（毫秒）
   */
  add(key, value, ttl) {
    if (typeof value !== 'object' || value === null) {
      throw new Error('缓存值必须是对象')
    }

    // 清理旧的注册信息
    const oldToken = this.tokens.get(key)
    if (oldToken) {
      this.registry.unregister(oldToken)
    }

    // 注册新的缓存值
    const token = {}
    this.tokens.set(key, token)
    this.cache.set(key, new WeakRef(value))
    this.registry.register(value, key, token) // 注册清理回调
    if (typeof ttl === 'number' && ttl > 0) {
      const timeout = setTimeout(() => {
        this.delete(key)
      }, ttl)
      this.timeouts.set(key, timeout)
    }
  }
  /**
   * 获取缓存项
   * @param {string} key - 缓存键
   * @returns {object|null} - 缓存值或 null
   */
  get(key) {
    const ref = this.cache.get(key)
    if (ref) {
      const value = ref.deref();
      if (value) return value;
      // 如果对象已被 GC，同步清理缓存表    
      console.log(`弱引用失效，清除缓存 key = ${key}`);
      this.delete(key);
    }
    return null
  }
  /**
   * 检查缓存项是否存在
   * @param {string} key - 缓存键
   * @returns {boolean} - 是否存在
   */
  has(key) {
    return this.get(key) !== null;
  }
  /**
   * 删除缓存项
   * @param {string} key - 缓存键
   */
  delete(key) {
    this.cache.delete(key)

    const token = this.tokens.get(key)
    if (token) {
      this.registry.unregister(token)
      this.tokens.delete(key)
    }
    if (this.timeouts.has(key)) {
      clearTimeout(this.timeouts.get(key))
      this.timeouts.delete(key)
    }
  }
  /**
   * 清空所有缓存项
   */
  clear() {
    for (const key of this.cache.keys()) {
      this.delete(key)
    }
  }
}