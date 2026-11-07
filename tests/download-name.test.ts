import { describe, expect, test } from 'bun:test'
import {
  contentDisposition,
  safeDownloadName,
} from '../src/modules/documents/documents'

describe('download file name', () => {
  test('keeps ordinary names and uses the detected extension', () => {
    expect(safeDownloadName('Payslip March.pdf', 'pdf')).toBe('Payslip March.pdf')
    expect(safeDownloadName('scan.PNG', 'jpeg')).toBe('scan.jpg')
  })

  test('neutralises header-breaking characters', () => {
    const name = safeDownloadName('a"b\r\nX-Evil: 1;.pdf', 'pdf')
    for (const c of ['"', '\r', '\n', ';']) expect(name).not.toContain(c)
    expect(name.endsWith('.pdf')).toBe(true)
    expect(contentDisposition(name)).not.toMatch(/[\r\n]/)
  })

  test('strips path separators', () => {
    const name = safeDownloadName('../../etc/passwd.pdf', 'pdf')
    expect(name).not.toContain('/')
    expect(name).not.toContain('\\')
    expect(safeDownloadName('..\\..\\win.ini.pdf', 'pdf')).not.toContain('\\')
  })

  test('replaces non-ASCII characters', () => {
    expect(safeDownloadName('Résumé.pdf', 'pdf')).toBe('R_sum_.pdf')
  })

  test('falls back when nothing safe is left', () => {
    expect(safeDownloadName('<<>>.pdf', 'pdf')).toBe('____.pdf')
    expect(safeDownloadName('', 'png')).toBe('document.png')
  })

  test('caps the length', () => {
    const name = safeDownloadName(`${'a'.repeat(500)}.pdf`, 'pdf')
    expect(name).toBe(`${'a'.repeat(80)}.pdf`)
  })

  test('the header is an attachment with a plain and an encoded name', () => {
    expect(contentDisposition('Payslip March.pdf')).toBe(
      `attachment; filename="Payslip March.pdf"; filename*=UTF-8''Payslip%20March.pdf`
    )
  })
})
