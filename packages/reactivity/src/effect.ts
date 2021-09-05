import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// 理论上, 将依赖视为维护一组订阅者的 Dep 类更容易，但我们只是将它们存储为原始集合以减少内存开销。
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.

type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

// The number of effects currently being tracked recursively.
// 当前effect被递归的track层数
let effectTrackDepth = 0 // ?

export let trackOpBit = 1 // ?

/**
 * The bitwise track markers support at most 30 levels op recursion.
 * 按位跟踪标记最多支持 30 级操作递归。
 * This value is chosen to enable modern JS engines to use a SMI on all platforms.
 * 选择此值是为了使现代 JS 引擎能够在所有平台上使用 SMI。
 * When recursion depth is greater, fall back to using a full cleanup.
 * 当递归深度更大时，回退到使用完全清理
 */
const maxMarkerBits = 30 // 最多30级操作递归

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

const effectStack: ReactiveEffect[] = []
let activeEffect: ReactiveEffect | undefined // 保存当前活跃的effect

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

// 生成effect实例的类
export class ReactiveEffect<T = any> {
  active = true // ?
  deps: Dep[] = [] // 存放收集当前effect的数据

  // can be attached after creation
  computed?: boolean // ?
  allowRecurse?: boolean // ?
  onStop?: () => void // ?
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  constructor(
    public fn: () => T, // 用户传入effect中的函数
    public scheduler: EffectScheduler | null = null, // 默认声明一个scheduler
    scope?: EffectScope | null // ?
  ) {
    recordEffectScope(this, scope)
  }

  run() { // 作用：执行fn()
    // 第一次不会执行
    if (!this.active) { // 如果active为false 默认为true
      return this.fn() // 执行fn
    }
    
    if (!effectStack.includes(this)) { // effectStack栈中不包含这个effect实例
      try {
        effectStack.push((activeEffect = this)) // 将当前effect赋值给activeEffect 并push到effectStack中
        enableTracking() // ?
        
        // << 移位运算符 为什么要移位运算?
        trackOpBit = 1 << ++effectTrackDepth

        if (effectTrackDepth <= maxMarkerBits) { // 如果没有超过30层
          initDepMarkers(this) 
        } else { // 超过30层
          cleanupEffect(this)
        }
        return this.fn() // 返回fn()函数的返回值
      } finally { // try内的代码执行完无论有无报错都会执行
        if (effectTrackDepth <= maxMarkerBits) { // effect的track深度未超过30层
          finalizeDepMarkers(this)
        }

        trackOpBit = 1 << --effectTrackDepth

        resetTracking()
        effectStack.pop()
        const n = effectStack.length
        activeEffect = n > 0 ? effectStack[n - 1] : undefined
      }
    }
  }

  stop() {
    if (this.active) {
      cleanupEffect(this)
      if (this.onStop) {
        this.onStop()
      }
      this.active = false
    }
  }
}

function cleanupEffect(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

// 接口
export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

// 接口
export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T, // 用户传入的函数
  options?: ReactiveEffectOptions // 用户传入的额外选项
): ReactiveEffectRunner {
  // 如果用户传入的函数是effect的返回值 也就是runner函数
  if ((fn as ReactiveEffectRunner).effect) {
    fn = (fn as ReactiveEffectRunner).effect.fn // 取runner上的fn函数也就是原始函数
  }
  
  // 实例化ReactiveEffect
  const _effect = new ReactiveEffect(fn)

  if (options) { // 如果effect中存在options
    extend(_effect, options) // 将options用Object.assign合并到_effect这个对象上
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  
  // options不存在或者options存在但无lazy属性
  if (!options || !options.lazy) { // 默认执行一次
    _effect.run() // 执行_effect实例的run()方法 也就是执行了一次fn()
  }

  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner // runner是真正的effect的返回结果
  runner.effect = _effect // 将effect这个类保存到runner的effect属性上
  return runner // 返回runner方法
}

export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

let shouldTrack = true // 当前effect是否允许被收集
const trackStack: boolean[] = [] // 存放effect是否允许被收集标识

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack) // 将标识push到trackStack中
  shouldTrack = true // 置为true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/**
 * 
 * @param target 被代理的对象
 * @param type track的类型
 * @param key 被代理的对象的key
 * @returns 
 */
export function track(target: object, type: TrackOpTypes, key: unknown) {
  if (!isTracking()) { // 不能被收集依赖 直接return
    return
  }

  let depsMap = targetMap.get(target) // targetMap中是否收集过target

  if (!depsMap) { // 不存在
    targetMap.set(target, (depsMap = new Map()))
  }

  let dep = depsMap.get(key) // depsMap中是否收集过对应的 key

  if (!dep) { // 未被收集过 创建对应的Set
    depsMap.set(key, (dep = createDep()))
  }

  const eventInfo = __DEV__
    ? { effect: activeEffect, target, type, key }
    : undefined // 开发环境
  trackEffects(dep, eventInfo)
}

export function isTracking() {
  // shouldTrack === true && activeEffect有值 说明可以收集effect
  return shouldTrack && activeEffect !== undefined
}

/**
 * @description 将key对应的effect收集起来
 * @param dep 存放key对应的effect的Set实例
 * @param debuggerEventExtraInfo dev环境才有
 */
export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  
  let shouldTrack = false // 是否应该收集

  if (effectTrackDepth <= maxMarkerBits) { // 未超过30层
    if (!newTracked(dep)) {
      dep.n |= trackOpBit // set newly tracked
      shouldTrack = !wasTracked(dep) // 是否应该track
    }
  } else { // 超过30层
    // Full cleanup mode.
    shouldTrack = !dep.has(activeEffect!)
  }

  if (shouldTrack) { // 应该收集
    dep.add(activeEffect!) // 将effect添加到dep中
    activeEffect!.deps.push(dep) // 将收集当前effect的dep添加到effect实例的deps属性中 实现dep和effect的双向记忆
    if (__DEV__ && activeEffect!.onTrack) {
      activeEffect!.onTrack(
        Object.assign(
          {
            effect: activeEffect!
          },
          debuggerEventExtraInfo
        )
      )
    }
  }
}

export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  let deps: (Dep | undefined)[] = []
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    console.log('Array', arguments);
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        deps.push(dep)
      }
    })
  } else {
    console.log('Object', arguments);
    
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined

  if (deps.length === 1) {
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        triggerEffects(deps[0])
      }
    }
  } else {
    const effects: ReactiveEffect[] = []
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}

export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization
  for (const effect of isArray(dep) ? dep : [...dep]) {
    if (effect !== activeEffect || effect.allowRecurse) {
      if (__DEV__ && effect.onTrigger) {
        effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
      }
      if (effect.scheduler) {
        effect.scheduler()
      } else {
        effect.run()
      }
    }
  }
}

console.log(targetMap);
