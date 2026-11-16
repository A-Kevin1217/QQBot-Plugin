import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GROUP_REMOVE_BATCH_LIMIT,
  normalizeMemberOpenids,
  chunkMemberOpenids,
  buildRemoveMemberRequests
} from '../lib/groupMembers.js'

test('成员描述整理成 openid 列表：字符串 / 数字 / 对象 / 单值都接受', () => {
  assert.deepEqual(normalizeMemberOpenids(['A1', 123, { member_openid: 'B2' }]), ['A1', '123', 'B2'])
  assert.deepEqual(normalizeMemberOpenids('A1'), ['A1'])
  assert.deepEqual(normalizeMemberOpenids({ user_id: 'C3' }), ['C3'])
  assert.deepEqual(normalizeMemberOpenids(null), [])
})

test('去重且保持首次出现顺序', () => {
  assert.deepEqual(
    normalizeMemberOpenids(['B', 'A', { member_openid: 'B' }, 'A', 'C']),
    ['B', 'A', 'C']
  )
})

test('resolveOpenid 负责剥掉框架前缀，还原失败（空串）的条目丢弃', () => {
  const resolve = value => String(value).replace(/^123456:/, '')
  assert.deepEqual(
    normalizeMemberOpenids(['123456:OPENID_A', 'OPENID_B', { member_openid: '123456:' }], resolve),
    ['OPENID_A', 'OPENID_B']
  )
})

test('按官方上限 20 分批，边界值不多不少', () => {
  const make = n => Array.from({ length: n }, (_, i) => `id${i}`)
  assert.equal(GROUP_REMOVE_BATCH_LIMIT, 20)
  assert.deepEqual(chunkMemberOpenids(make(0)), [])
  assert.equal(chunkMemberOpenids(make(20)).length, 1)
  assert.equal(chunkMemberOpenids(make(21)).length, 2)
  assert.equal(chunkMemberOpenids(make(21))[1].length, 1)
  assert.equal(chunkMemberOpenids(make(45)).length, 3)
})

test('buildRemoveMemberRequests：整理 → 还源 → 去重 → 分批一次到位', () => {
  const resolve = value => String(value).replace(/^9:/, '')
  const batches = buildRemoveMemberRequests(
    ['9:A', 'A', { member_openid: '9:B' }, 'C'],
    resolve
  )
  assert.deepEqual(batches, [['A', 'B', 'C']])

  const many = Array.from({ length: 25 }, (_, i) => `id${i}`)
  const split = buildRemoveMemberRequests(many, v => v)
  assert.equal(split.length, 2)
  assert.equal(split[0].length, 20)
  assert.equal(split[1].length, 5)

  assert.deepEqual(buildRemoveMemberRequests([], v => v), [])
  assert.deepEqual(buildRemoveMemberRequests(['', null, undefined], v => v), [])
})
