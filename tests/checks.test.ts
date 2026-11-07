import { describe, expect, test } from 'bun:test'
import {
  checkSubmission,
  detectType,
  type IncomingFile,
  MAX_FILE_BYTES,
} from '../src/modules/documents/checks'
import { elf, exe, jpeg, pdf, png, sized } from './fixtures'

const file = (field: string, name: string, bytes: Uint8Array): IncomingFile => ({
  field,
  name,
  bytes,
})
const reasons = (r: ReturnType<typeof checkSubmission>) =>
  r.ok ? [] : r.problems.map((p) => p.reason)

describe('upload checks', () => {
  test('types are recognised by content', () => {
    expect(detectType(pdf())).toBe('pdf')
    expect(detectType(png())).toBe('png')
    expect(detectType(jpeg())).toBe('jpeg')
    expect(detectType(exe())).toBeNull()
    expect(detectType(elf())).toBeNull()
    expect(detectType(new Uint8Array())).toBeNull()
    expect(detectType(new Uint8Array([0x25, 0x50]))).toBeNull()
  })

  test('AC-3 (unit): an executable named .pdf is rejected', () => {
    const r = checkSubmission([file('payslip', 'payslip.pdf', exe())], ['payslip'])
    expect(reasons(r)).toContain('payslip.pdf: not a PDF, JPG or PNG file')
  })

  test('AC-4 (unit): a file over 10 MB is rejected; exactly 10 MB is accepted', () => {
    const big = checkSubmission(
      [file('payslip', 'big.pdf', sized(pdf(), MAX_FILE_BYTES + 1))],
      ['payslip']
    )
    expect(reasons(big)).toEqual(['big.pdf: larger than 10 MB'])
    const exact = checkSubmission(
      [file('payslip', 'exact.pdf', sized(pdf(), 10 * 1024 * 1024))],
      ['payslip']
    )
    expect(exact.ok).toBe(true)
  })

  test('every requested type needs a file', () => {
    const r = checkSubmission(
      [file('payslip', 'p.pdf', pdf())],
      ['payslip', 'photo_id']
    )
    expect(reasons(r)).toEqual(['Missing: Photo ID'])
  })

  test('files under an unrequested type are rejected', () => {
    for (const field of ['bank_statement', 'passport']) {
      const r = checkSubmission(
        [file('payslip', 'p.pdf', pdf()), file(field, 's.pdf', pdf())],
        ['payslip']
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.problems.map((p) => p.field)).toEqual([field])
    }
  })

  test('more than ten files are rejected', () => {
    const files = Array.from({ length: 11 }, (_, i) =>
      file('payslip', `p${i}.pdf`, pdf())
    )
    expect(reasons(checkSubmission(files, ['payslip']))).toEqual([
      'Too many files (at most 10)',
    ])
  })

  test('a submission with no files is refused', () => {
    expect(checkSubmission([], ['payslip']).ok).toBe(false)
  })

  test('all problems are reported together', () => {
    const r = checkSubmission(
      [
        file('payslip', 'payslip.pdf', exe()),
        file('payslip', 'big.pdf', sized(pdf(), MAX_FILE_BYTES + 1)),
      ],
      ['payslip', 'photo_id']
    )
    expect(reasons(r).sort()).toEqual([
      'Missing: Photo ID',
      'big.pdf: larger than 10 MB',
      'payslip.pdf: not a PDF, JPG or PNG file',
    ])
  })

  test('an accepted submission tags each file with its type', () => {
    const r = checkSubmission(
      [
        file('payslip', 'a.pdf', pdf()),
        file('payslip', 'b.png', png()),
        file('photo_id', 'id.jpg', jpeg()),
      ],
      ['payslip', 'photo_id']
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.files.map((f) => [f.name, f.documentType, f.detectedType])).toEqual([
      ['a.pdf', 'payslip', 'pdf'],
      ['b.png', 'payslip', 'png'],
      ['id.jpg', 'photo_id', 'jpeg'],
    ])
  })
})
