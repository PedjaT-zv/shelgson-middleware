import type { CollectionConfig } from 'payload'

/**
 * A daily-synced mirror of the DK "Vörubók" product catalog, pulled from the
 * dkPlus REST API by the `syncCatalog` job (rows DK doesn't have are removed).
 * `itemCode` (DK's vörunúmer) is the business key used to resolve the product
 * an inquiry asks for, and the key DK prices are injected into the Excel
 * quote's Vörulisti price tables by.
 */
export const CatalogItems: CollectionConfig = {
  slug: 'catalog-items',
  admin: {
    useAsTitle: 'itemCode',
    defaultColumns: ['itemCode', 'description', 'unitPrice1WithTax', 'unitPrice1', 'lastSyncedAt'],
    group: 'DK Catalog',
  },
  access: {
    read: () => true,
  },
  fields: [
    {
      name: 'itemCode',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      admin: {
        description: 'DK ItemCode / vörunúmer, stored lowercase as in DK (matched case-insensitively).',
      },
    },
    { name: 'recordId', type: 'number', admin: { description: 'DK internal RecordID.' } },
    { name: 'description', type: 'text' },
    { name: 'description2', type: 'text' },
    { name: 'unitCode', type: 'text' },
    { name: 'group', type: 'text' },
    { name: 'unitPrice1', type: 'number', admin: { description: 'Net unit price.' } },
    {
      name: 'unitPrice1WithTax',
      type: 'number',
      admin: { description: 'VAT-inclusive unit price — the price quotes use.' },
    },
    { name: 'taxPercent', type: 'number' },
    { name: 'currencyCode', type: 'text', defaultValue: 'ISK', admin: { description: 'Currency of the prices.' } },
    { name: 'inactive', type: 'checkbox', defaultValue: false },
    { name: 'showItemInWebShop', type: 'checkbox', defaultValue: false },
    {
      name: 'recordModified',
      type: 'date',
      index: true,
      admin: { description: 'DK RecordModified — when the product was last edited in DK.' },
    },
    { name: 'lastSyncedAt', type: 'date', admin: { description: 'When DK data last changed this row.' } },
  ],
}
