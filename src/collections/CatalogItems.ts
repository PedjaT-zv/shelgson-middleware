import type { CollectionConfig } from 'payload'

/**
 * A daily-synced mirror of the DK "Vörubók" product catalog, pulled from the
 * dkPlus REST API by the `syncCatalog` job. `itemCode` (DK's vörunúmer) is the
 * business key used to resolve the product an inquiry asks for, and it is the
 * key the Excel quote's VLOOKUP price table is populated from.
 */
export const CatalogItems: CollectionConfig = {
  slug: 'catalog-items',
  admin: {
    useAsTitle: 'itemCode',
    defaultColumns: ['itemCode', 'description', 'unitPrice1', 'currencyCode', 'lastSyncedAt'],
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
      admin: { description: 'DK ItemCode / vörunúmer — the product business key.' },
    },
    { name: 'recordId', type: 'number', admin: { description: 'DK internal RecordID.' } },
    { name: 'description', type: 'text' },
    { name: 'description2', type: 'text' },
    { name: 'unitCode', type: 'text' },
    { name: 'group', type: 'text' },
    { name: 'unitPrice1', type: 'number', admin: { description: 'Net unit price.' } },
    { name: 'unitPrice1WithTax', type: 'number', admin: { description: 'VAT-inclusive unit price.' } },
    { name: 'taxPercent', type: 'number' },
    { name: 'currencyCode', type: 'text', defaultValue: 'ISK' },
    { name: 'inactive', type: 'checkbox', defaultValue: false },
    { name: 'showItemInWebShop', type: 'checkbox', defaultValue: false },
    {
      name: 'recordModified',
      type: 'date',
      index: true,
      admin: { description: 'DK RecordModified — drives incremental sync.' },
    },
    { name: 'lastSyncedAt', type: 'date' },
  ],
}
