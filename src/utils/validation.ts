import { z } from "zod";

export const normalizePhone = (input: string) => {
  const phone = input.replace(/\D/g, "");
  if (!phone) return "";
  if (/^254(7|1)\d{8}$/.test(phone)) return phone;
  if (/^2540(7|1)\d{8}$/.test(phone)) return `254${phone.slice(4)}`;
  if (/^0(7|1)\d{8}$/.test(phone)) return `254${phone.slice(1)}`;
  if (/^(7|1)\d{8}$/.test(phone)) return `254${phone}`;
  return "";
};

export const stkPushSchema = z.object({
  phoneNumber: z.string().min(1),
  amount: z.coerce.number().positive(),
  accountReference: z.string().min(1).max(50),
  transactionDesc: z.string().min(1).max(100),
  idempotencyKey: z.string().optional(),
  userRef: z.string().optional(),
  domainBooking: z
    .object({
      full_name: z.string().min(1),
      phone: z.string().min(1),
      email: z.string().email(),
      domain_name: z.string().min(1),
    })
    .optional(),
});

export type StkPushInput = z.infer<typeof stkPushSchema>;
