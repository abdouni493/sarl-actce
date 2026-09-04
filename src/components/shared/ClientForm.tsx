import { useState } from 'react';
import { MapPin, Phone, User, FileText } from 'lucide-react';
import { Input, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useLanguage } from '@/hooks/useLanguage';
import type { Client } from '@/types';

interface ClientFormProps {
  initial?: Client | null;
  onSubmit: (data: Omit<Client, 'id'>) => void;
  onCancel: () => void;
  /** Rend l'adresse obligatoire (création d'une commande / d'un bon de livraison). */
  requireAddress?: boolean;
}

export function ClientForm({ initial, onSubmit, onCancel, requireAddress }: ClientFormProps) {
  const { t } = useLanguage();
  const [form, setForm] = useState({
    name: initial?.name || '',
    phone: initial?.phone || '',
    address: initial?.address || '',
    note: initial?.note || '',
    rc: initial?.rc || '',
    nif: initial?.nif || '',
    nis: initial?.nis || '',
    article: initial?.article || '',
  });
  const [error, setError] = useState('');
  const [addressError, setAddressError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let ok = true;
    if (!form.name.trim()) { setError('Nom requis'); ok = false; } else setError('');
    if (requireAddress && !form.address.trim()) {
      setAddressError('Adresse requise'); ok = false;
    } else setAddressError('');
    if (!ok) return;
    onSubmit({
      name: form.name.trim(),
      phone: form.phone.trim(),
      address: form.address.trim(),
      note: form.note.trim(),
      rc: form.rc.trim(),
      nif: form.nif.trim(),
      nis: form.nis.trim(),
      article: form.article.trim(),
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        label={`${t('name')} *`} value={form.name} icon={<User size={15} />}
        onChange={(e) => setForm({ ...form, name: e.target.value })} error={error} autoFocus
      />
      <Input
        label={t('phone')} value={form.phone} icon={<Phone size={15} />}
        onChange={(e) => setForm({ ...form, phone: e.target.value })}
      />
      <Input
        label={`Adresse${requireAddress ? ' *' : ''}`}
        value={form.address}
        icon={<MapPin size={15} />}
        placeholder="Ex : Cité 200 logements, Blida"
        onChange={(e) => setForm({ ...form, address: e.target.value })}
        error={addressError}
      />
      <div className="rounded-xl border border-gold/20 bg-vanilla/40 p-3 space-y-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-gold flex items-center gap-2">
          <FileText size={13} /> Identifiants fiscaux (bloc « DOIT » des factures)
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="R.C N°" value={form.rc} placeholder="Ex : 09/00-19/B/0810390"
            onChange={(e) => setForm({ ...form, rc: e.target.value })}
          />
          <Input
            label="N° Article" value={form.article} placeholder="Ex : 09012255011"
            onChange={(e) => setForm({ ...form, article: e.target.value })}
          />
          <Input
            label="NIF" value={form.nif} placeholder="Ex : 001909081039015"
            onChange={(e) => setForm({ ...form, nif: e.target.value })}
          />
          <Input
            label="NIS" value={form.nis} placeholder="Ex : 0019 09010033461"
            onChange={(e) => setForm({ ...form, nis: e.target.value })}
          />
        </div>
      </div>
      <Textarea
        label="Note (optionnel)" rows={2} value={form.note}
        onChange={(e) => setForm({ ...form, note: e.target.value })}
      />
      <div className="flex justify-end gap-3 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel}>{t('cancel')}</Button>
        <Button type="submit" variant="gold">{t('save')}</Button>
      </div>
    </form>
  );
}
